import { lambdasWithMissingApiDependency } from '../../../../provider-utils/awscloudformation/utils/getDependentFunction';
import { loadFunctionParameters } from '../../../../provider-utils/awscloudformation/utils/loadFunctionParameters';
import { $TSContext } from 'amplify-cli-core';

jest.mock('fs-extra');
jest.mock('../../../../provider-utils/awscloudformation/utils/loadFunctionParameters');
jest.mock('path');
jest.mock('amplify-cli-core', () => ({
  JSONUtilities: {
    readJson: jest.fn(),
    writeJson: jest.fn(),
  },
}));
const contextStub = {
  amplify: {
    updateamplifyMetaAfterResourceUpdate: jest.fn(),
    copyBatch: jest.fn(),
  },
};

const allResources = [
  {
    service: 'AppSync',
    providerPlugin: 'awscloudformation',
  },
  {
    build: true,
    providerPlugin: 'awscloudformation',
    service: 'Lambda',
    resourceName: 'fn1',
  },
  {
    build: true,
    providerPlugin: 'awscloudformation',
    service: 'Lambda',
    dependsOn: [],
    resourceName: 'fn1',
  },
  {
    build: true,
    providerPlugin: 'awscloudformation',
    service: 'Lambda',
    resourceName: 'fn2',
    dependsOn: [
      {
        category: 'api',
        resourceName: 'mock_api',
        attributes: ['GraphQLAPIIdOutput'],
      },
    ],
  },
  {
    build: true,
    providerPlugin: 'awscloudformation',
    service: 'Lambda',
    resourceName: 'fn3',
    dependsOn: [
      {
        category: 'api',
        resourceName: 'mock_api',
        attributes: ['GraphQLAPIIdOutput'],
      },
    ],
  },
];
const backendDir = 'randomPath';
const loadResourceParameters_mock = loadFunctionParameters as jest.MockedFunction<typeof loadFunctionParameters>;

describe('get dependent functions', () => {
  it('using one out of three models', async () => {
    jest.clearAllMocks();
    const existingModels = ['model1'];
    const FunctionMetaExpected = ['fn2', 'fn3'];
    loadResourceParameters_mock
      .mockReturnValueOnce({
        permissions: {
          storage: {
            model1: ['create'],
            model2: ['create'],
            model3: ['create'],
          },
        },
      })
      .mockReturnValueOnce({
        permissions: {
          storage: {
            model3: ['create'],
          },
        },
      });
    const fnMetaToBeUpdated = await lambdasWithMissingApiDependency(
      contextStub as unknown as $TSContext,
      allResources,
      backendDir,
      existingModels,
    );
    expect(fnMetaToBeUpdated.map(resource => resource.resourceName).toString()).toBe(FunctionMetaExpected.toString());
  });
});

describe('get dependent functions with empty permissions', () => {
  it('using two out of three models', async () => {
    jest.clearAllMocks();
    const existingModels = ['model1', 'model2'];
    const FunctionMetaExpected = ['fn2'];
    loadResourceParameters_mock
      .mockReturnValueOnce({
        permissions: {
          storage: {
            model1: ['create'],
            model2: ['create'],
            model3: ['create'],
          },
        },
      })
      .mockReturnValueOnce({});
    const fnMetaToBeUpdated = await lambdasWithMissingApiDependency(
      contextStub as unknown as $TSContext,
      allResources,
      backendDir,
      existingModels,
    );
    expect(fnMetaToBeUpdated.map(resource => resource.resourceName).toString()).toBe(FunctionMetaExpected.toString());
  });
});
