require('../src/aws-matchers/'); // custom matcher for assertion
import { initJSProjectWithProfile, deleteProject, amplifyPushAuth } from '../src/init';
import { addSampleInteraction } from '../src/categories/interactions';
import { createNewProjectDir, deleteProjectDir, getProjectMeta, getBot } from '../src/utils';

describe('amplify add interactions', () => {
  let projRoot: string;
  beforeEach(() => {
    projRoot = createNewProjectDir('interaction');
    jest.setTimeout(1000 * 60 * 60); // 1 hour
  });

  afterEach(async () => {
    await deleteProject(projRoot);
    deleteProjectDir(projRoot);
  });

  it('init a project and add  simple interaction', async () => {
    await initJSProjectWithProfile(projRoot, {});
    await addSampleInteraction(projRoot, {});
    await amplifyPushAuth(projRoot);
    const meta = getProjectMeta(projRoot);
    const { FunctionArn: functionArn, BotName: botName, Region: region } = Object.keys(meta.interactions).map(
      key => meta.interactions[key]
    )[0].output;
    expect(functionArn).toBeDefined();
    expect(botName).toBeDefined();
    expect(region).toBeDefined();
    const bot = await getBot(botName, region);
    expect(bot.name).toEqual(botName);
  });
});
