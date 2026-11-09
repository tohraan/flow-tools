import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { openCdp, positionTarget, wire } from '../flow-lib.mjs';
import { needsPause } from '../flow-safety.mjs';

class Socket extends EventTarget {
  sent = [];
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.dispatchEvent(new Event('close')); }
  reply(result) { this.dispatchEvent(new MessageEvent('message', {data: JSON.stringify({id:this.sent.at(-1).id, result})})); }
}

test('a completed command clears its deadline and accepts the next response', async () => {
  const socket = new Socket();
  const send = wire(socket, 10);
  const first = send('Runtime.evaluate');
  socket.reply({value:1});
  assert.deepEqual(await first, {value:1});
  await new Promise(resolve => setTimeout(resolve, 20));
  const next = send('Runtime.evaluate');
  socket.reply({value:2});
  assert.deepEqual(await next, {value:2});
  socket.close();
});

test('a browser command without a reply times out and preserves the pause', async () => {
  const send = wire(new Socket(), 5);
  await assert.rejects(send('Input.dispatchMouseEvent'), error => /FLOW_CDP_TIMEOUT.*Input.dispatchMouseEvent/.test(error.message) && needsPause(error));
});

test('disconnect rejects every pending command and later sends', async () => {
  const socket = new Socket();
  const send = wire(socket);
  const first = assert.rejects(send('Runtime.evaluate'), error => needsPause(error));
  const second = assert.rejects(send('Page.captureScreenshot'), /FLOW_CDP_DISCONNECTED/);
  socket.close();
  await Promise.all([first,second]);
  await assert.rejects(send('Input.insertText'), /FLOW_CDP_DISCONNECTED/);
});

test('a synchronous socket failure also fails closed', async () => {
  const socket = new Socket();
  socket.send = () => {throw new Error('closed');};
  await assert.rejects(wire(socket)('Input.dispatchMouseEvent'), error => needsPause(error));
});

test('a socket that never opens has a bounded handshake', async t => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  t.after(() => {globalThis.WebSocket = original;});
  await assert.rejects(openCdp('ws://offline.test', 5), /FLOW_CDP_TIMEOUT/);
});

test('positioning works when a hidden tab never fires animation frames', {timeout:100}, async () => {
  let scrolled = false;
  const element = {isConnected:true,scrollIntoView(){scrolled=true;},getBoundingClientRect(){return {left:20,top:40,width:100,height:40};}};
  const send = async (method, params) => {
    assert.equal(method,'Runtime.evaluate');
    return {result:{value:vm.runInNewContext(params.expression,{document:{querySelector(){return element;}},innerWidth:800,innerHeight:600,requestAnimationFrame(){}})}};
  };
  assert.deepEqual(JSON.parse(JSON.stringify(await positionTarget(send, 'document.querySelector("textarea")'))), {x:70,y:60});
  assert.equal(scrolled,true);
});
