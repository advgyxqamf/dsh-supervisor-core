'use strict';

const portsShared = require('../../platform/service/ports').shared;

// app/assembly/api-rebind.js —— HTTP 监听主机重绑（面板切换「局域网访问」）。
//
// 本逻辑创建 HTTP 服务，若直接 require api 则构成 app -> api 越界（契约 DS-3），
// 故 createServer 作为注入依赖（由 root 在装配时传入），app 只依赖抽象，不依赖 api 模块。

function _rebindApiHost(host, createServer) {
    // createServer 由 root 注入（见文件头说明：避免 app -> api 越界，契约 DS-3）。
    const old = host.api;
    if (old) {
      try { old.close(); } catch {}
      try { if (typeof old.closeAllConnections === 'function') old.closeAllConnections(); } catch {}
    }
    const bind = () => {
      const server = createServer(host);
      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          // 端口仍被旧连接占用：短暂等待后重试；10 次后降级为 30s 慢重试（持续自愈，绝不永久下线）
          const tries = bind._tries || 0;
          if (tries < 10) {
            bind._tries = tries + 1;
            setTimeout(bind, 300);
          } else {
            bind._tries = 0;
            setTimeout(bind, 30000);
            host.events.append('api_error', { message: 'API 重绑端口持续被占用，30s 后自动重试: ' + err.message });
            host.logger.error('api rebind degraded (30s slow retry): ' + err.message);
          }
          return;
        }
        host.events.append('api_error', { message: err.message });
        host.logger.error('api error: ' + err.message);
      });
      server.listen(host.config.apiPort, host.config.apiHost, () => {
        bind._tries = 0;
        host.api = server;
        // 重绑成功后同样登记**实际端口**（与 start() 的 listen 一致；D3）。
        try { portsShared.register('supervisor-api', host.config.apiPort); } catch (e) { host.logger.warn('ports.register(supervisor-api) 失败: ' + ((e && e.message) || e)); }
        host.events.append('api_listening', { host: host.config.apiHost, port: host.config.apiPort });
        host.logger.info('api listening on ' + host.config.apiHost + ':' + host.config.apiPort);
      });
    };
    bind._tries = 0;
    host.api = null;
    bind();
}

  /** 启动 HTTP API 服务（端口避让）。createServer 同为注入（见文件头 DS-3 说明）。 */
function startApi(host, createServer) {
  const maxSkew = 50;
  const attempt = (port, skew) => {
    const server = createServer(host);
    server.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE' && skew < maxSkew) {
        const next = host.config.apiPort + skew + 1;
        host.events.append('api_port_skew', { from: host.config.apiPort, to: next, reason: err.message });
        host.logger.warn('api port ' + port + ' occupied, trying ' + next + ': ' + err.message);
        return attempt(next, skew + 1);
      }
      host.events.append('api_error', { message: err ? err.message : String(err) });
      host.logger.error('api error: ' + (err ? err.message : String(err)));
    });
    server.listen(port, host.config.apiHost, () => {
      host.api = server;
      const prev = host.config.apiPort;
      if (port !== prev) {
        // 释放旧端口登记：否则 ports.json 会留两条 supervisor-api，
        //   而壳的就绪判据取首条，可能永远等「已废弃的旧端口」。
        try { portsShared.release(prev, 'system:supervisor-api'); } catch {}
        host.config.apiPort = port;
        if (host.configPath) host.persistConfigPatch({ apiPort: port });
      }
      // 登记**实际绑定端口**（KERNEL-DAEMON-CONTRACT D3）：壳的唯一就绪判据。
      try { portsShared.register('supervisor-api', port); } catch (e) { host.logger.warn('ports.register(actual) 失败: ' + e.message); }
      host.events.append('api_listening', { host: host.config.apiHost, port });
      host.logger.info('api listening on ' + host.config.apiHost + ':' + port);
    });
    return server;
  };
  host.api = attempt(host.config.apiPort, 0);
  }


module.exports = { _rebindApiHost, startApi };
