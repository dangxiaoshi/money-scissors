#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR=path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR=path.resolve(SCRIPT_DIR,'..');
const FIXTURE=path.join(WEB_DIR,'data/practice-templates/launch-live-20260612.json');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HTTP_PORT=8137;
const DEBUG_PORT=9342;
const ORIGIN=`http://127.0.0.1:${HTTP_PORT}`;
const results=[];
const browserLogs=[];

function check(name,condition,detail){
  results.push({name,pass:Boolean(condition),detail:condition?undefined:detail});
}

function contentType(file){
  return ({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.mp3':'audio/mpeg','.m4a':'audio/mp4'})[path.extname(file).toLowerCase()]||'application/octet-stream';
}

const server=http.createServer((req,res)=>{
  const pathname=decodeURIComponent(new URL(req.url,ORIGIN).pathname);
  const file=path.resolve(WEB_DIR,'.'+pathname);
  if(!file.startsWith(WEB_DIR+path.sep)){res.writeHead(403);res.end('forbidden');return;}
  fs.readFile(file,(error,data)=>{
    if(error){res.writeHead(404);res.end('not found');return;}
    res.writeHead(200,{'Content-Type':contentType(file)});res.end(data);
  });
});
await new Promise(resolve=>server.listen(HTTP_PORT,'127.0.0.1',resolve));

const fixture=JSON.parse(fs.readFileSync(FIXTURE,'utf8'));
const chrome=spawn(CHROME,['--headless=new','--disable-gpu','--no-first-run','--force-device-scale-factor=1',`--remote-debugging-port=${DEBUG_PORT}`,`--user-data-dir=/tmp/ms-review-regression-${process.pid}`,'about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function json(pathname){const response=await fetch(`http://127.0.0.1:${DEBUG_PORT}${pathname}`);return response.json();}
let version;
for(let i=0;i<50;i++){try{version=await json('/json/version');break;}catch{await sleep(200);}}
if(!version) throw new Error('Chrome 调试端口未启动');

let ws,messageId=0;
const pending=new Map();
const eventHandlers=[];
await new Promise(resolve=>{
  ws=new WebSocket(version.webSocketDebuggerUrl);
  ws.onopen=resolve;
  ws.onmessage=event=>{
    const message=JSON.parse(event.data);
    if(message.id&&pending.has(message.id)){pending.get(message.id)(message);pending.delete(message.id);return;}
    eventHandlers.forEach(handler=>handler(message));
  };
});
function command(method,params={},sessionId){
  return new Promise((resolve,reject)=>{
    const id=++messageId;
    pending.set(id,message=>message.error?reject(new Error(`${method}: ${JSON.stringify(message.error)}`)):resolve(message.result));
    ws.send(JSON.stringify({id,method,params,sessionId}));
  });
}
const {targetId}=await command('Target.createTarget',{url:'about:blank'});
const {sessionId}=await command('Target.attachToTarget',{targetId,flatten:true});
const send=(method,params)=>command(method,params,sessionId);
await send('Page.enable');
await send('Runtime.enable');
eventHandlers.push(message=>{
  if(message.method==='Runtime.exceptionThrown') browserLogs.push(`EXCEPTION ${message.params.exceptionDetails?.exception?.description||message.params.exceptionDetails?.text}`);
  if(message.method==='Runtime.consoleAPICalled'&&['error','warning'].includes(message.params.type)) browserLogs.push(`${message.params.type.toUpperCase()} ${message.params.args.map(arg=>arg.value||arg.description||'').join(' ')}`);
});
async function evaluate(expression){
  const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
  return result.result.value;
}

try{
  await send('Page.navigate',{url:`${ORIGIN}/login.html`});
  await sleep(500);
  await evaluate(`localStorage.setItem('jinqian_data',${JSON.stringify(JSON.stringify(fixture))});'ok'`);
  await send('Page.navigate',{url:`${ORIGIN}/review.html`});
  await sleep(1200);
  for(let i=0;i<40;i++){if(await evaluate(`document.querySelectorAll('#tx .r-transcript-text').length`))break;await sleep(150);}
  await evaluate(`window.__test={
    point(container,offset){const walker=document.createTreeWalker(container,NodeFilter.SHOW_TEXT);let total=0,node,last=null;while((node=walker.nextNode())){last=node;const length=node.nodeValue.length;if(offset<=total+length)return{node,offset:Math.max(0,offset-total)};total+=length;}return{node:last,offset:last?last.nodeValue.length:0};},
    container(idx){return document.querySelector('#r'+idx+' .r-transcript-text');},
    fullLen(idx){const sentence=S.find(item=>item.idx===idx);return sentence.w.map(word=>word.t).join('').length;},
    select(startIdx,startOffset,endIdx,endOffset,reverse=false){const a=this.point(this.container(startIdx),startOffset),b=this.point(this.container(endIdx),endOffset),selection=getSelection();selection.removeAllRanges();if(reverse){const range=document.createRange();range.setStart(b.node,b.offset);range.collapse(true);selection.addRange(range);selection.extend(a.node,a.offset);}else{const range=document.createRange();range.setStart(a.node,a.offset);range.setEnd(b.node,b.offset);selection.addRange(range);}return selection.toString();},
    selectSpeakers(startIdx,endIdx){const a=document.querySelector('#r'+startIdx+' .r-sp'),b=document.querySelector('#r'+endIdx+' .r-sp'),range=document.createRange(),selection=getSelection();range.setStart(a.firstChild||a,0);range.setEnd(b.firstChild||b,0);selection.removeAllRanges();selection.addRange(range);},
    reset(){previewMode=false;document.body.classList.remove('preview');del.clear();gold.clear();introClips.length=0;breathCuts=[];for(const key in pdel)delete pdel[key];kpUndoStack.length=0;kpRedoStack.length=0;cachedPreviewDeletionRanges=null;renderAll();},
    snap(){return{del:[...del].sort((a,b)=>a-b),pdel:JSON.parse(JSON.stringify(pdel)),segments:currentExportDeleteSegments()};}
  };'ready'`);

  // 原 32 项：跨句、恢复、撤销/前进、浮层、归一、性能与导出口径。
  await evaluate(`__test.reset();__test.select(10,5,13,6);handleSelDelete();`);
  let state=await evaluate(`__test.snap()`);
  check('01 正向跨句首句为局部删除',state.pdel['10']?.[0]?.cs===5,state);
  check('02 正向跨句中间第11句整句删除',state.del.includes(11),state);
  check('03 正向跨句中间第12句整句删除',state.del.includes(12),state);
  check('04 正向跨句末句为局部删除',state.pdel['13']?.[0]?.ce===6,state);
  const forward=JSON.stringify(state);

  await evaluate(`__test.reset();__test.select(10,5,13,6,true);handleSelDelete();`);
  state=await evaluate(`__test.snap()`);
  check('05 反向跨句与正向状态一致',JSON.stringify(state)===forward,{forward,state});

  await evaluate(`kpUndo()`);
  state=await evaluate(`__test.snap()`);
  check('06 一次撤销清空整次跨句删除',state.del.length===0&&Object.keys(state.pdel).length===0,state);
  await evaluate(`kpRedo()`);
  state=await evaluate(`__test.snap()`);
  check('07 一次前进完整重做跨句删除',JSON.stringify(state)===forward,state);

  const crossSegments=state.segments;
  await evaluate(`__test.reset();__test.select(10,5,10,__test.fullLen(10));handleSelDelete();del.add(11);del.add(12);__test.select(13,0,13,6);handleSelDelete();cachedPreviewDeletionRanges=null;`);
  const sequential=await evaluate(`__test.snap()`);
  check('08 跨句与逐句 del 集合一致',JSON.stringify(sequential.del)===JSON.stringify([11,12]),sequential);
  check('09 跨句与逐句导出段一致',JSON.stringify(sequential.segments)===JSON.stringify(crossSegments),{crossSegments,sequential:sequential.segments});

  const perf=await evaluate(`(function(){__test.reset();let renders=0,saves=0;const oldRender=renderAll,oldSave=sv;window.renderAll=function(){renders++;return oldRender.apply(this,arguments)};window.sv=function(){saves++;};__test.select(5,3,55,4);const started=performance.now();handleSelDelete();const ms=performance.now()-started;window.renderAll=oldRender;window.sv=oldSave;return{renders,saves,ms:Math.round(ms),delCount:del.size};})()`);
  check('10 跨50句只重绘一次',perf.renders===1,perf);
  check('11 跨50句只保存一次',perf.saves===1,perf);
  check('12 跨50句增量耗时低于800ms',perf.ms<800,perf);

  await evaluate(`__test.reset();__test.select(20,10,20,30);handleSelDelete();__test.select(20,10,20,15);handleSelRestore();`);
  state=await evaluate(`__test.snap()`);
  check('13 局部删除恢复句头',state.pdel['20']?.[0]?.cs===15,state);
  await evaluate(`__test.select(20,25,20,30);handleSelRestore();`);
  state=await evaluate(`__test.snap()`);
  check('14 局部删除恢复句尾',state.pdel['20']?.[0]?.ce===25,state);
  await evaluate(`__test.select(20,18,20,22);handleSelRestore();`);
  state=await evaluate(`__test.snap()`);
  check('15 局部删除恢复中间拆成两段',state.pdel['20']?.length===2,state);
  check('16 恢复中间左段字符边界正确',state.pdel['20']?.[0]?.ce===18,state);
  check('17 恢复中间右段字符边界正确',state.pdel['20']?.[1]?.cs===22,state);

  await evaluate(`__test.reset();del.add(10);renderAll();__test.select(10,0,10,5);handleSelRestore();`);
  state=await evaluate(`__test.snap()`);
  const full10=await evaluate(`__test.fullLen(10)`);
  check('18 整句删除恢复句头后退出 del',!state.del.includes(10),state);
  check('19 整句其余文字转成 pdel',state.pdel['10']?.[0]?.cs===5&&state.pdel['10']?.[0]?.ce===full10,state);
  const audioPosition=await evaluate(`au.currentTime`);
  const restoredStart=await evaluate(`pdelEntryFromChars(S.find(x=>x.idx===10),0,5).s`);
  check('20 恢复后播放器定位到前约0.3秒',Math.abs(audioPosition-Math.max(0,restoredStart-0.3))<0.05,{audioPosition,restoredStart});
  await evaluate(`kpUndo()`);
  check('21 恢复操作一次撤销回整句删除',await evaluate(`del.has(10)&&!pdel[10]`),await evaluate(`__test.snap()`));
  await evaluate(`kpRedo()`);
  check('22 恢复操作一次前进完整重做',await evaluate(`!del.has(10)&&pdel[10]?.[0]?.cs===5`),await evaluate(`__test.snap()`));

  await evaluate(`__test.reset();__test.select(30,5,30,15);handleSelDelete();__test.select(30,10,30,25);handleSelDelete();`);
  state=await evaluate(`__test.snap()`);
  check('23 重叠且音频连续的 pdel 归一为一段',state.pdel['30']?.length===1,state);
  check('24 归一后的字符范围是[5,25)',state.pdel['30']?.[0]?.cs===5&&state.pdel['30']?.[0]?.ce===25,state);

  await evaluate(`__test.reset();__test.select(8,2,8,10);buildSelBtn(collectSelectionRows());`);
  let actions=await evaluate(`[...selbtn.querySelectorAll('button')].map(button=>button.dataset.act)`);
  check('25 单句未删浮层显示删除+片头',JSON.stringify(actions)===JSON.stringify(['delete','intro']),actions);
  await evaluate(`__test.select(8,2,10,5);buildSelBtn(collectSelectionRows());`);
  actions=await evaluate(`[...selbtn.querySelectorAll('button')].map(button=>button.dataset.act)`);
  check('26 多句浮层只显示删除',JSON.stringify(actions)===JSON.stringify(['delete']),actions);
  await evaluate(`__test.reset();__test.select(8,2,8,20);handleSelDelete();__test.select(8,0,8,25);buildSelBtn(collectSelectionRows());`);
  actions=await evaluate(`[...selbtn.querySelectorAll('button')].map(button=>button.dataset.act)`);
  check('27 单句混合选区显示删除+恢复',actions.includes('delete')&&actions.includes('restore'),actions);
  await evaluate(`__test.select(8,5,8,15);buildSelBtn(collectSelectionRows());`);
  actions=await evaluate(`[...selbtn.querySelectorAll('button')].map(button=>button.dataset.act)`);
  check('28 单句全删选区只显示恢复',JSON.stringify(actions)===JSON.stringify(['restore']),actions);

  await evaluate(`__test.reset();__test.selectSpeakers(8,9);buildSelBtn(collectSelectionRows());`);
  actions=await evaluate(`[...selbtn.querySelectorAll('button')].map(button=>button.dataset.act)`);
  check('29 说话人跨行选区隐藏片头',!actions.includes('intro'),actions);
  check('30 说话人跨行选区按多句判断',await evaluate(`selectionIsMultiRow(collectSelectionRows())`),actions);

  await evaluate(`__test.reset();__test.select(10,5,13,6);handleSelDelete();`);
  const exportSanity=await evaluate(`(function(){const segments=currentExportDeleteSegments();return{segments,valid:segments.every((segment,index)=>segment.end>segment.start&&(index===0||segment.start>=segments[index-1].end))};})()`);
  check('31 导出段无重叠/负数/零长度',exportSanity.valid,exportSanity);
  check('32 控制台无脚本异常',browserLogs.filter(line=>line.startsWith('EXCEPTION')).length===0,browserLogs);

  // 新增阻断回归。
  await evaluate(`__test.reset();const first=S[0];del.add(first.idx);renderAll();__test.select(first.idx,0,first.idx,5);handleSelRestore();`);
  state=await evaluate(`__test.snap()`);
  const keptHead=await evaluate(`pdelEntryFromChars(S[0],0,5)`);
  check('33 首句恢复句头后不再落入导出删除段',!state.segments.some(segment=>segment.start<keptHead.e&&segment.end>keptHead.s),{keptHead,segments:state.segments});
  check('34 首句恢复句头后的首删除段不从0开始',state.segments[0]?.start>=keptHead.e-0.001,state);
  await evaluate(`__test.reset();del.add(S[0].idx);cachedPreviewDeletionRanges=null;`);
  state=await evaluate(`__test.snap()`);
  check('35 首句全部删除时仍可延伸到0秒',state.segments[0]?.start===0,state);
  await evaluate(`(function(){__test.reset();const first=S[0];first.__originalWords=first.w;first.w=[{t:'甲乙',s:0.2,e:0.24},{t:'后文',s:0.3,e:0.4}];pdel[first.idx]=[pdelEntryFromChars(first,1,__test.fullLen(first.idx))];cachedPdelRanges=null;cachedPreviewDeletionRanges=null;})()`);
  state=await evaluate(`__test.snap()`);
  check('35A 恢复不足40ms的极短句头也不得扩到0秒',state.segments[0]?.start>=0.219&&state.segments[0]?.start<0.241,state);
  await evaluate(`S[0].w=S[0].__originalWords;delete S[0].__originalWords;__test.reset();`);

  await evaluate(`(function(){__test.reset();const a=S[5],b=S[6];del.add(a.idx);renderAll();__test.select(a.idx,3,b.idx,3);handleSelDelete();})()`);
  state=await evaluate(`__test.snap()`);
  check('36 正向混合删除不在整句 del 下新增隐藏 pdel',!state.pdel['5'],state);
  check('37 正向混合删除保留 A 的整句删除',state.del.includes(5),state);
  check('37A 正向混合删除仍处理未删 B 的选区',state.pdel['6']?.some(g=>g.cs===0&&g.ce===3),state);
  await evaluate(`(function(){__test.reset();const a=S[8],b=S[9];del.add(b.idx);renderAll();__test.select(a.idx,3,b.idx,3,true);handleSelDelete();})()`);
  state=await evaluate(`__test.snap()`);
  const full8=await evaluate(`__test.fullLen(8)`);
  check('38 反向边界混合删除不在整句 del 下新增隐藏 pdel',!state.pdel['9'],state);
  check('39 反向边界混合删除保留 B 的整句删除',state.del.includes(9),state);
  check('39A 反向混合删除仍处理未删 A 的选区',state.pdel['8']?.some(g=>g.cs===3&&g.ce===full8),state);
  await evaluate(`__test.reset();__test.select(12,2,12,8);handleSelDelete();const before={state:JSON.stringify(__test.snap()),undo:kpUndoStack.length,redo:kpRedoStack.length};kpUndo();kpRedo();__test.select(12,2,12,8);window.__duplicateBefore={state:JSON.stringify(__test.snap()),undo:kpUndoStack.length,redo:kpRedoStack.length};handleSelDelete();window.__duplicateAfter={state:JSON.stringify(__test.snap()),undo:kpUndoStack.length,redo:kpRedoStack.length};`);
  const duplicateDelete=await evaluate(`({before:window.__duplicateBefore,after:window.__duplicateAfter})`);
  check('39B 已被 pdel 完整覆盖的选区重复删除为 no-op',JSON.stringify(duplicateDelete.before)===JSON.stringify(duplicateDelete.after),duplicateDelete);

  await evaluate(`__test.reset();__test.select(12,2,12,4);handleSelDelete();del.add(13);breathThreshold=0.01;renderAll();setMode('preview');`);
  await evaluate(`__test.select(12,2,14,3)`);
  check('40 粗剪试听模式过滤所有选区行',await evaluate(`collectSelectionRows().length===0`),await evaluate(`collectSelectionRows()`));
  const previewBefore=await evaluate(`JSON.stringify(__test.snap())`);
  await evaluate(`handleSelDelete()`);
  const previewAfter=await evaluate(`JSON.stringify(__test.snap())`);
  check('41 粗剪试听模式禁止执行删除',previewBefore===previewAfter,{previewBefore,previewAfter});
  const previewHistoryBefore=await evaluate(`({state:JSON.stringify(__test.snap()),undo:kpUndoStack.length,redo:kpRedoStack.length})`);
  await evaluate(`tgS(12)`);
  const previewRowAfter=await evaluate(`({state:JSON.stringify(__test.snap()),undo:kpUndoStack.length,redo:kpRedoStack.length})`);
  check('41A 粗剪试听模式的整句删除不改状态或历史栈',JSON.stringify(previewHistoryBefore)===JSON.stringify(previewRowAfter),{previewHistoryBefore,previewRowAfter});
  check('41B0 撤销回归执行前历史栈确有可撤销记录',previewRowAfter.undo>0,previewRowAfter);
  await evaluate(`kpUndo()`);
  const previewUndoAfter=await evaluate(`({state:JSON.stringify(__test.snap()),undo:kpUndoStack.length,redo:kpRedoStack.length})`);
  check('41B 粗剪试听模式的撤销不改状态或历史栈',JSON.stringify(previewRowAfter)===JSON.stringify(previewUndoAfter),{previewRowAfter,previewUndoAfter});
  const previewCandidates=await evaluate(`({koupi:kpAllHits().length})`);
  check('41C 试听回归样本确有口癖候选',previewCandidates.koupi>0,previewCandidates);
  const previewBulkBefore=await evaluate(`({state:JSON.stringify(__test.snap()),undo:kpUndoStack.length,redo:kpRedoStack.length})`);
  await evaluate(`kpKillAll()`);
  const previewKoupiAfter=await evaluate(`({state:JSON.stringify(__test.snap()),undo:kpUndoStack.length,redo:kpRedoStack.length})`);
  check('41D 粗剪试听模式的一键口癖删除不改状态或历史栈',JSON.stringify(previewBulkBefore)===JSON.stringify(previewKoupiAfter),{previewBulkBefore,previewKoupiAfter});
  await evaluate(`__test.reset();breathThreshold=0.01;renderAll();setMode('preview')`);
  const previewBreathCandidates=await evaluate(`breathPendingCandidates().length`);
  check('41D1 气口回归执行前确有待缩短候选',previewBreathCandidates>0,previewBreathCandidates);
  const previewBreathBefore=await evaluate(`({state:JSON.stringify(__test.snap()),undo:kpUndoStack.length,redo:kpRedoStack.length})`);
  await evaluate(`breathShortenAll()`);
  const previewBreathAfter=await evaluate(`({state:JSON.stringify(__test.snap()),undo:kpUndoStack.length,redo:kpRedoStack.length})`);
  check('41D2 粗剪试听模式的一键气口删除不改状态或历史栈',JSON.stringify(previewBreathBefore)===JSON.stringify(previewBreathAfter),{previewBreathBefore,previewBreathAfter});
  await evaluate(`__test.reset();__test.select(12,2,12,4);handleSelDelete();kpUndo();setMode('preview')`);
  const previewRedoBefore=await evaluate(`({state:JSON.stringify(__test.snap()),undo:kpUndoStack.length,redo:kpRedoStack.length})`);
  check('41E0 前进回归执行前历史栈确有可前进记录',previewRedoBefore.redo>0,previewRedoBefore);
  await evaluate(`kpRedo()`);
  const previewRedoAfter=await evaluate(`({state:JSON.stringify(__test.snap()),undo:kpUndoStack.length,redo:kpRedoStack.length})`);
  check('41E 粗剪试听模式的前进不改状态或历史栈',JSON.stringify(previewRedoBefore)===JSON.stringify(previewRedoAfter),{previewRedoBefore,previewRedoAfter});
  await evaluate(`setMode('edit')`);

  await evaluate(`__test.reset();__test.selectSpeakers(18,19);handleSelDelete();`);
  state=await evaluate(`__test.snap()`);
  check('42 浮层和执行共用跨行判断：完整正文进 del',state.del.includes(18),state);
  check('43 跨行完整正文不误存单句 pdel',!state.pdel['18'],state);

  await evaluate(`__test.reset();pdel[0]=[{cs:0,ce:1,s:2,e:3},{cs:1,ce:2,s:7.36,e:8}];normalizePdelForSentence(0);cachedPdelRanges=null;cachedPreviewDeletionRanges=null;`);
  state=await evaluate(`__test.snap()`);
  check('44 字符相邻但音频相隔4.36秒时保持两段',state.pdel['0']?.length===2,state);
  check('45 归一未扩大实际删除范围',Math.abs(state.pdel['0'][0].e-state.pdel['0'][0].s+state.pdel['0'][1].e-state.pdel['0'][1].s-1.64)<0.001,state);
  check('45A 最终导出仍为两段且未吞掉中间长气口',state.segments.length===2&&state.segments[0].end<=3.001&&state.segments[1].start>=7.359,state);

  await evaluate(`__test.reset();del.add(11);renderAll();__test.select(10,2,12,3);buildSelBtn(collectSelectionRows());`);
  actions=await evaluate(`[...selbtn.querySelectorAll('button')].map(button=>button.dataset.act)`);
  check('46 跨多句混合选区隐藏恢复操作',!actions.includes('restore'),actions);
  const restoreBefore=await evaluate(`JSON.stringify(__test.snap())`);
  await evaluate(`handleSelRestore()`);
  const restoreAfter=await evaluate(`JSON.stringify(__test.snap())`);
  check('47 跨多句恢复执行层同样拒绝修改',restoreBefore===restoreAfter,{restoreBefore,restoreAfter});
} finally {
  chrome.kill('SIGKILL');
  server.close();
}

const failed=results.filter(result=>!result.pass);
console.log('==== REVIEW SELECTION REGRESSION ====');
results.forEach(result=>console.log(`${result.pass?'✅':'❌'} ${result.name}${result.pass?'':` -> ${JSON.stringify(result.detail)}`}`));
console.log(`\nPASS ${results.length-failed.length}/${results.length}`);
console.log(`BROWSER WARNINGS/ERRORS ${browserLogs.length}`);
browserLogs.forEach(line=>console.log(`  ${line}`));
process.exit(failed.length?1:0);
