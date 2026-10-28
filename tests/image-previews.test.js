const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function harness(){
 let callback;const calls=[],images=[];
 const window={FieldDesktop:{isDesktop:true,request(method,args){return new Promise(resolve=>calls.push({method,args,resolve}));}}};
 const document={querySelectorAll:()=>images};
 class IntersectionObserver{constructor(fn){callback=fn;} observe(){} unobserve(){} disconnect(){}}
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../image-previews.js'),'utf8'),{window,document,IntersectionObserver});
 const item=(id='a',stamp='1')=>({id,kind:'file',native:{referenceId:id,path:'C:\\photo.png',modifiedUtc:stamp,size:10,status:'available'}});
 const image=id=>{const node={dataset:{imagePreview:id},classList:{contains:()=>false},isConnected:true,hidden:true,remove(){this.removed=true;},set src(value){this.url=value;this.onload?.();}};images.push(node);return node;};
 return{window,calls,images,item,image,observe(items){window.FieldPreviews.observe(items);callback(images.map(target=>({target,isIntersecting:true})));}};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('rows and details share a single lazy request and cached preview',async()=>{
 const h=harness(),a=h.image('a'),b=h.image('a');h.observe([h.item()]);assert.equal(h.calls.length,1);assert.equal(h.calls[0].method,'files.preview');
 h.calls[0].resolve({available:true,dataUrl:'data:image/png;base64,AA==',width:10,height:20});await tick();assert.equal(a.hidden,false);assert.equal(a.url,b.url);
 h.images.length=0;const c=h.image('a');h.observe([h.item()]);await tick();assert.equal(h.calls.length,1);assert.equal(c.hidden,false);
});
test('preview work is limited to two active native requests',async()=>{
 const h=harness();for(const id of ['a','b','c'])h.image(id);h.observe(['a','b','c'].map(id=>h.item(id)));assert.equal(h.calls.length,2);
 h.calls[0].resolve({available:false});await tick();assert.equal(h.calls.length,3);assert.equal(h.images[0].removed,true);
 h.calls[1].resolve({available:false});h.calls[2].resolve({available:false});await tick();
});
test('metadata changes invalidate cached previews and unavailable files are excluded',async()=>{
 const h=harness();h.image('a');h.observe([h.item()]);h.calls[0].resolve({available:false});await tick();
 h.images.length=0;h.image('a');h.observe([h.item('a','2')]);assert.equal(h.calls.length,2);h.calls[1].resolve({available:false});await tick();
 const missing=h.item();missing.native.status='replaced';assert.equal(h.window.FieldPreviews.supported(missing),false);
 const svg=h.item();svg.native.path='C:\\image.svg';assert.equal(h.window.FieldPreviews.supported(svg),false);
});
