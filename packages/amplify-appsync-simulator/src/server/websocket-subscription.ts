import { DocumentNode, GraphQLSchema } from 'graphql';
import { IncomingMessage, Server } from 'http';
import { AmplifyAppSyncSimulator } from '..';
import { extractHeader, extractJwtToken, getAuthorizationMode } from '../utils/auth-helpers';
import { AppSyncGraphQLExecutionContext } from '../utils/graphql-runner';
import { runSubscription, SubscriptionResult } from '../utils/graphql-runner/subscriptions';
import { ConnectionContext, WebsocketSubscriptionServer } from './subscription/websocket-server/server';
import { AmplifyAppSyncAPIConfig } from '../type-definition';

export class AppSyncSimulatorSubscriptionServer {
  private realtimeServer: WebsocketSubscriptionServer;
  constructor(
    private schema: GraphQLSchema,
    private appSyncConfig: AmplifyAppSyncAPIConfig,
    private server: Server,
    private subscriptionPath: string = '/graphql',
  ) {
    this.onSubscribe = this.onSubscribe.bind(this);
    this.onConnect = this.onConnect.bind(this);
    this.realtimeServer = new WebsocketSubscriptionServer(
      {
        onSubscribeHandler: this.onSubscribe,
        onConnectHandler: this.onConnect,
      },
      {
        server: this.server,
        path: this.subscriptionPath,
      },
    );
  }
  start() {
    this.realtimeServer.start();
  }
  stop() {
    this.realtimeServer.stop();
  }

  async onSubscribe(
    doc: DocumentNode,
    variable: Record<string, any>,
    headers: Record<string, any>,
    request: IncomingMessage,
    operationName?: string,
  ) {
    const ipAddress = request.socket.remoteAddress;
    const authorization = extractHeader(headers, 'Authorization');
    const jwt = extractJwtToken(authorization);
    const requestAuthorizationMode = getAuthorizationMode(headers, this.appSyncConfig);
    const executionContext: AppSyncGraphQLExecutionContext = {
      jwt,
      sourceIp: ipAddress,
      headers,
      requestAuthorizationMode,
      appsyncErrors: [],
    };
    const subscriptionResult = await runSubscription(this.schema, doc, variable, operationName, executionContext);
    if ((subscriptionResult as SubscriptionResult).asyncIterator) {
      return (subscriptionResult as SubscriptionResult).asyncIterator;
    }
    return subscriptionResult;
  }

  onConnect(message: ConnectionContext, headers: Record<string, any>) {
    this.authorizeRequest(headers);
  }

  authorizeRequest(headers: Record<string, string>) {
    return getAuthorizationMode(headers, this.appSyncConfig);
  }
}
