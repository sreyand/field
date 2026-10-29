const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function harness() {
  const timers = new Map(), details = [], opened = [];
  let next = 0, ready = true;
  const context = vm.createContext({setTimeout(fn, delay){const id=++next;timers.set(id,{fn,delay});return id;},clearTimeout(id){timers.delete(id);}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../item-activation.js'),'utf8'),context);
  const records = {a:{kind:'file'},b:{kind:'file'},note:{kind:'note'}};
  const activation=context.FieldActivation.create({getItem:id=>records[id],showDetails:id=>details.push(id),openFile:id=>opened.push(id),canActivate:()=>ready,getDelay:()=>800});
  return {activation,timers,details,opened,records,set ready(value){ready=value;},flush(){for(const task of [...timers.values()])task.fn();}};
}
test('one file click defers details through the Windows double-click interval',()=>{
  const h=harness();h.activation.click('a',1);assert.equal(h.activation.pending,true);assert.deepEqual(h.details,[]);assert.equal([...h.timers.values()][0].delay,830);h.flush();assert.deepEqual(h.details,['a']);assert.deepEqual(h.opened,[]);assert.equal(h.activation.pending,false);
});
test('double-click opens once and cancels the details panel; triple-click does not reopen',()=>{
  const h=harness();h.activation.click('a',1);h.activation.click('a',2);h.activation.click('a',3);h.flush();assert.deepEqual(h.opened,['a']);assert.deepEqual(h.details,[]);assert.equal(h.timers.size,0);
});
test('navigation cancellation and different targets cannot activate a stale file',()=>{
  const h=harness();h.activation.click('a',1);h.activation.cancel();h.activation.click('a',2);h.flush();assert.deepEqual(h.opened,[]);assert.deepEqual(h.details,[]);h.activation.click('a',1);h.activation.click('b',2);h.flush();assert.deepEqual(h.opened,[]);
});
test('keyboard details and non-file items remain immediate',()=>{
  const h=harness();h.activation.click('a',0);h.activation.click('note',1);assert.deepEqual(h.details,['a','note']);assert.equal(h.timers.size,0);assert.deepEqual(h.opened,[]);
});
test('busy state and removed records prevent delayed or duplicate activation',()=>{
  const h=harness();h.activation.click('a',1);h.ready=false;h.flush();assert.deepEqual(h.details,[]);h.activation.click('a',2);assert.deepEqual(h.opened,[]);h.ready=true;h.activation.click('a',1);delete h.records.a;h.flush();assert.deepEqual(h.details,[]);
});
