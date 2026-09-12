// Small test-only CDP client; no browser profile or credential reads.
export async function connectTarget(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
  });
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {pending.delete(id);reject(new Error(`Timed out: ${method}`));}, 20000);
        pending.set(id, {resolve,reject,timer});
        socket.send(JSON.stringify({id,method,params}));
      });
    },
    async evaluate(expression) {
      const result = await this.send("Runtime.evaluate", {expression,awaitPromise:true,returnByValue:true});
      if(result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result?.value;
    },
    close() {socket.close();},
  };
}

export async function appTargets(port = 9229) {
  return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(t=>t.type === "page" && t.url?.startsWith("app://-/index.html"));
}
