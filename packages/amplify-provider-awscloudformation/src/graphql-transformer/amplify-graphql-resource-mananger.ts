import path from 'path';
import fs from 'fs-extra';
import _ from 'lodash';
import configurationManager from '../configuration-manager';
import { diff as getDiffs, Diff } from 'deep-diff';
import { sanityCheck } from 'graphql-transformer-core';
import { Template, DynamoDB } from 'cloudform-types';
import { $TSContext } from 'amplify-cli-core';
import { CloudFormation } from 'aws-sdk';
import { getStackParameters, GSIStatus, GSIRecord, TemplateState, getTableARNS } from '../utils/amplify-resource-state-utils';
import { GlobalSecondaryIndex, KeySchema, AttributeDefinition } from 'cloudform-types/types/dynamoDb/table';
import { DeploymentStep } from '../iterative-deployment/state-machine';
import { hashDirectory, ROOT_APPSYNC_S3_KEY } from '../upload-appsync-files';
import { DiffChanges, getGQLDiff, DiffableProject } from './utils';

export type GQLResourceManagerProps = {
  cfnClient: CloudFormation;
  resourceMeta: $ResourceMeta | null;
  backendDir: string;
  cloudBackendDir: string;
};

export type $ResourceMeta = {
  category: string;
  providerPlugin: string;
  resourceName: string;
  service: string;
  output: any;
  providerMetadata: {
    s3TemplateURL: string;
    logicalId: string;
  };
  stackId: string;
  DeploymentBucketName: string;
  [key: string]: any;
};

// TODO: Add unit testing
export class GraphQLResourceManager {
  static serviceName: string = 'AppSync';
  static categoryName: string = 'api';
  private cfnClient: CloudFormation;
  private resourceMeta: $ResourceMeta;
  private cloudBackendDir: string;
  private backendDir: string;
  private templateState: TemplateState;

  public static createInstance = async (context: $TSContext, gqlResource: any, StackId: string) => {
    try {
      const cred = await configurationManager.loadConfiguration(context);
      const cfn = new CloudFormation(cred);
      const apiStack = await cfn
        .describeStackResources({ StackName: StackId, LogicalResourceId: gqlResource.providerMetadata.logicalId })
        .promise();
      return new GraphQLResourceManager({
        cfnClient: cfn,
        resourceMeta: { ...gqlResource, stackId: apiStack.StackResources[0].PhysicalResourceId },
        backendDir: context.amplify.pathManager.getBackendDirPath(),
        cloudBackendDir: context.amplify.pathManager.getCurrentCloudBackendDirPath(),
      });
    } catch (err) {
      throw err;
    }
  };

  constructor(props: GQLResourceManagerProps) {
    if (!props.resourceMeta) {
      throw Error('No GraphQL API enabled.');
    }
    this.cfnClient = props.cfnClient;
    this.resourceMeta = props.resourceMeta;
    this.backendDir = path.join(props.backendDir, GraphQLResourceManager.categoryName, this.resourceMeta.resourceName);
    this.cloudBackendDir = path.join(props.cloudBackendDir, GraphQLResourceManager.categoryName, this.resourceMeta.resourceName);
    this.templateState = new TemplateState();
  }

  run = async (): Promise<DeploymentStep[]> | null => {
    const gqlDiff = getGQLDiff(this.backendDir, this.cloudBackendDir);
    try {
      sanityCheck(gqlDiff.diff, gqlDiff.current, gqlDiff.next);
    } catch (err) {
      if (err.name !== 'InvalidGSIMigrationError') {
        throw err;
      }
    }
    this.gsiManagement(gqlDiff.diff, gqlDiff.current, gqlDiff.next);
    return await this.getDeploymentSteps();
  };

  // save states to build with a copy of build on every deploy
  getDeploymentSteps = async (): Promise<DeploymentStep[]> => {
    let count = 0;
    const gqlSteps = new Array<DeploymentStep>();
    const tempDir = path.join(this.cloudBackendDir, 'build', 'states');
    const stateFileDir = path.join(this.backendDir, 'build');
    const tableArnMap = await getTableARNS(this.cfnClient, this.templateState.getKeys(), this.resourceMeta.stackId);
    const parameters = await getStackParameters(this.cfnClient, this.resourceMeta.stackId);
    const buildHash = await hashDirectory(this.backendDir);
    fs.ensureDirSync(tempDir);
    while (!this.templateState.isEmpty()) {
      fs.copySync(stateFileDir, path.join(tempDir, `${count}`));
      const tables = this.templateState.getKeys();
      const tableArns = [];
      tables.forEach(key => {
        tableArns.push(tableArnMap.get(key));
        const filepath = path.join(stateFileDir, `${count}`, 'stacks', `${key}.json`);
        fs.writeFileSync(filepath, JSON.stringify(this.templateState.pop(key), null, 2));
      });
      gqlSteps.push({
        stackTemplatePath: this.resourceMeta.providerMetadata.s3TemplateURL,
        parameters: { ...parameters, S3DeploymentRootKey: `${ROOT_APPSYNC_S3_KEY}/${buildHash}/states/${count}` },
        stackName: this.resourceMeta.stackId,
        tableNames: tableArns,
      });
      count++;
    }
    fs.moveSync(tempDir, path.join(stateFileDir, 'states'));
    return gqlSteps;
  };

  private gsiManagement = (diffs: DiffChanges<DiffableProject>, currentState: DiffableProject, nextState: DiffableProject) => {
    const gsiChanges = _.filter(diffs, diff => {
      return _.includes(diff.path, 'GlobalSecondaryIndexes');
    });
    for (const gsiChange of gsiChanges) {
      const tableName = gsiChange.path[3];
      const stackName = gsiChange.path[1].split('.')[0];
      const gsiStatus = this.gsiChangeStatus(gsiChange, currentState, nextState);
      const ddbResource = this.templateState.getLatest(stackName) || this.getStack(stackName, currentState);

      if (gsiStatus === GSIStatus.add) {
        const indexName = (gsiChange as any).item.rhs.IndexName;
        let gsiRecord = this.getGSIRecord(indexName, this.getTable(gsiChange, nextState));
        this.addGSI(gsiRecord, tableName, ddbResource);
        this.templateState.add(stackName, JSON.stringify(ddbResource));
      }
      // if its an edit most likely one gsi is removed and another was added
      // by using the index name we can check which values to remove
      else if (gsiStatus === GSIStatus.edit) {
        const gsiPath = gsiChange.path.slice(0, 7);
        const rhsGSIName = _.get(nextState, gsiPath).IndexName;
        const lhsGSIName = _.get(currentState, gsiPath).IndexName;
        // remove the gsi
        this.deleteGSI(lhsGSIName, tableName, ddbResource);
        this.templateState.add(stackName, JSON.stringify(ddbResource));
        // add the gsi
        const gsiRecord = this.getGSIRecord(rhsGSIName, this.getTable(gsiChange, nextState));
        this.addGSI(gsiRecord, tableName, ddbResource);
        this.templateState.add(stackName, JSON.stringify(ddbResource));
      } else if (gsiStatus === GSIStatus.delete) {
        const removedGSI = (gsiChange as any).item.lhs as GlobalSecondaryIndex;
        this.deleteGSI(removedGSI.IndexName as string, tableName, ddbResource);
        this.templateState.add(stackName, JSON.stringify(ddbResource));
      } else if (gsiStatus === GSIStatus.batchAdd) {
        const addedGSIs = (gsiChange as any).lhs as GlobalSecondaryIndex[];
        for (const gsi of addedGSIs) {
          // grab added gsi resources
          let gsiRecord = this.getGSIRecord(gsi.IndexName as string, this.getTable(gsiChange, nextState));
          this.addGSI(gsiRecord, tableName, ddbResource);
          this.templateState.add(stackName, JSON.stringify(ddbResource));
        }
      } else if (gsiStatus === GSIStatus.batchDelete) {
        const removedGSIs = (gsiChange as any).lhs as GlobalSecondaryIndex[];
        for (let gsi of removedGSIs) {
          // grab deleted gsi resource
          this.deleteGSI(gsi.IndexName as string, tableName, ddbResource);
          this.templateState.add(stackName, JSON.stringify(ddbResource));
        }
      }
    }
  };

  private gsiChangeStatus = (gsiChange: Diff<any, any>, current: DiffableProject, next: DiffableProject): GSIStatus => {
    if (gsiChange.kind === 'A') {
      if (gsiChange.item.kind === 'D' && gsiChange.item.lhs) {
        return GSIStatus.delete;
      }
      if (gsiChange.item.kind === 'N' && gsiChange.item.rhs) {
        return GSIStatus.add;
      }
    }
    if (gsiChange.kind === 'E' && gsiChange.lhs) {
      if (gsiChange.path.slice(-1)[0] === 'IndexName') return GSIStatus.edit;
      if (gsiChange.path.slice(-1)[0] === 'AttributeName') {
        // need to run a check to ensure this ks change is actually happening and not because the order changed.
        const innerDiffs = this.getInnerDiffs(gsiChange, current, next);
        const pathToGSI = gsiChange.path.slice(0, 7);
        const gsiIndexName = _.get(current, pathToGSI).IndexName;
        for (const innerDiff of innerDiffs) {
          if (innerDiff.kind === 'E' && innerDiff.path.slice(-1)[0] === 'AttributeName' && innerDiff.path[0] === gsiIndexName) {
            return GSIStatus.edit;
          }
        }
      }
    }
    if (gsiChange.kind === 'N' && gsiChange.rhs.length > 1) {
      return GSIStatus.batchAdd;
    }
    if (gsiChange.kind === 'D' && gsiChange.lhs.length > 1) {
      return GSIStatus.batchDelete;
    }
    return GSIStatus.none;
  };

  private getTable = (gsiChange: Diff<any, any>, proj: DiffableProject): DynamoDB.Table => {
    return proj.stacks[gsiChange.path[1]].Resources[gsiChange.path[3]] as DynamoDB.Table;
  };

  private getStack(stackName: string, proj: DiffableProject): Template {
    return proj.stacks[`${stackName}.json`];
  }

  private getInnerDiffs = (gsiChange: Diff<any, any>, current: DiffableProject, next: DiffableProject) => {
    const pathToGSIs = gsiChange.path.slice(0, 6);
    const oldIndexes = _.get(current, pathToGSIs);
    const newIndexes = _.get(next, pathToGSIs);
    const oldIndexesDiffable = _.keyBy(oldIndexes, 'IndexName');
    const newIndexesDiffable = _.keyBy(newIndexes, 'IndexName');
    return getDiffs(oldIndexesDiffable, newIndexesDiffable) || [];
  };
  /**
   * GSI Operations
   */
  private getGSIRecord = (indexName: string, table: DynamoDB.Table): GSIRecord => {
    const gsis = table.Properties.GlobalSecondaryIndexes as GlobalSecondaryIndex[];
    const addedGSI = (_.filter(gsis, {
      IndexName: indexName,
    }) as GlobalSecondaryIndex[])[0];
    const attrDefs = ((addedGSI.KeySchema as any) as AttributeDefinition[]).reduce((acc, attr) => {
      acc.push(attr.AttributeName);
      return acc;
    }, []);
    const attrDef = _.filter(table.Properties.AttributeDefinitions as AttributeDefinition[], defs => {
      return attrDefs.includes(defs.AttributeName);
    });
    return { gsi: addedGSI, attributeDefinition: attrDef };
  };

  private addGSI = (gsiRecord: GSIRecord, tableName: string, template: Template): void => {
    const table = template.Resources[tableName];
    const gsis = table.Properties.GlobalSecondaryIndexes as GlobalSecondaryIndex[];
    gsis.push(gsiRecord.gsi);
    const attrDefs = table.Properties.AttributeDefinitions as AttributeDefinition[];
    table.Properties.AttributeDefinitions = _.unionBy(attrDefs, gsiRecord.attributeDefinition, 'AttributeName');
  };

  private deleteGSI = (indexName: string, tableName: string, template: Template): void => {
    const table = template.Resources[tableName];
    const gsis = table.Properties.GlobalSecondaryIndexes as GlobalSecondaryIndex[];
    const attrDefs = table.Properties.AttributeDefinitions as AttributeDefinition[];
    const removedGSIKS = _.remove(gsis, { IndexName: indexName })[0]?.KeySchema as Array<KeySchema>;
    const currentKS = gsis.reduce((acc, gsi) => {
      acc.push(...(gsi.KeySchema as Array<KeySchema>));
      return acc;
    }, []);
    // values in removedGSIKS that is not existent in currentKS will be removed
    if (removedGSIKS) {
      const attrToRemove = _.differenceBy(removedGSIKS, currentKS, 'AttributeName');
      _.pullAllBy(attrDefs, attrToRemove, 'AttributeName');
    }
  };
}
