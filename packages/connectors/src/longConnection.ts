/**
 * 飞书长连接 transport（官方 SDK WebSocket）：
 * 不需要公网回调地址、不需要内网穿透——本地开发/单机部署的默认模式。
 * 事件分发桥接到 FeishuConnector.handleEventObject（与 webhook 同一套去重/解析/建任务逻辑）。
 */
export interface LongConnectionOptions {
  appId: string;
  appSecret: string;
  /** 收到明文事件对象（{schema, header, event}）时的处理回调 */
  onEvent: (event: unknown) => void | Promise<void>;
  log?: (msg: string) => void;
}

export async function startFeishuLongConnection(opts: LongConnectionOptions): Promise<void> {
  // SDK 各版本的 CJS/ESM 导出形态有差异，防御性取默认导出
  const mod = (await import("@larksuiteoapi/node-sdk")) as Record<string, unknown>;
  const lark = ((mod.default ?? mod) as {
    EventDispatcher: new () => { register(handlers: Record<string, (data: unknown) => unknown>): void };
    WSClient: new (o: { appId: string; appSecret: string; domain?: unknown; loggerLevel?: unknown }) => {
      start(o: { eventDispatcher: unknown }): Promise<void>;
    };
    Domain?: { Feishu: unknown };
    LoggerLevel?: { error: unknown };
  });

  const dispatcher = new lark.EventDispatcher();
  dispatcher.register({
    "im.message.receive_v1": async (data: unknown) => {
      await opts.onEvent(data);
    },
  });

  const wsClient = new lark.WSClient({
    appId: opts.appId,
    appSecret: opts.appSecret,
    domain: lark.Domain?.Feishu,
    loggerLevel: lark.LoggerLevel?.error,
  });
  await wsClient.start({ eventDispatcher: dispatcher });
  opts.log?.("飞书长连接已建立（无需公网回调地址，本地即可收事件）");
}
