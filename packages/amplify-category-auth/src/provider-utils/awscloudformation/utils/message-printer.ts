import { ServiceQuestionsResult } from '../service-walkthrough-types';
import { BannerMessage } from 'amplify-cli-core';
/**
 * A factory function that returns a function that prints the "success message" after adding auth
 * @param print The amplify print object
 */
export const getPostAddAuthMessagePrinter = (print: any) => (resourceName: string) => {
  print.success(`Successfully added auth resource ${resourceName} locally`);
  printCommonText(print);
};

/**
 * A factory function that returns a function that prints the "success message" after updating auth
 * @param context The amplify print object
 */
export const getPostUpdateAuthMessagePrinter = (print: any) => (resourceName: string) => {
  print.success(`Successfully updated auth resource ${resourceName} locally`);
  printCommonText(print);
};

const printCommonText = (print: any) => {
  print.info('');
  print.success('Some next steps:');
  print.info('"amplify push" will build all your local backend resources and provision it in the cloud');
  print.info(
    '"amplify publish" will build all your local backend and frontend resources (if you have hosting category added) and provision it in the cloud',
  );
  print.info('');
};

export const printSMSSandboxWarning = async (print: any) => {
  const postAddUpdateSMSSandboxInfo = await BannerMessage.getMessage('COGNITO_SMS_SANDBOX_CATEGORY_AUTH_ADD_OR_UPDATE_INFO');
  postAddUpdateSMSSandboxInfo && print.info(`${postAddUpdateSMSSandboxInfo}\n`);
};

export const doesConfigurationIncludeSMS = (request: ServiceQuestionsResult): boolean => {
  if ((request.mfaConfiguration === 'OPTIONAL' || request.mfaConfiguration === 'ON') && request.mfaTypes?.includes('SMS Text Message')) {
    return true;
  }

  if (request.usernameAttributes?.includes('phone_number')) {
    return true;
  }

  return false;
};
