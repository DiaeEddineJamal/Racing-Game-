import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const CHROME=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p=>fs.existsSync(p));
fs.mkdirSync('shots-mobile',{recursive:true});
const b=await puppeteer.launch({executablePath:CHROME,headless:'new',args:['--no-sandbox','--mute-audio','--enable-unsafe-swiftshader'],defaultViewport:null});
const p=await b.newPage();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const UA='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
await p.setUserAgent(UA);
await p.setViewport({width:844,height:390,deviceScaleFactor:2,isMobile:true,hasTouch:true,isLandscape:true});
const click=async t=>p.evaluate(x=>[...document.querySelectorAll('button')].find(b=>b.offsetParent&&b.textContent.trim().toLowerCase()===x.toLowerCase())?.click(),t);
await p.goto('http://localhost:3100/?auto=1',{waitUntil:'domcontentloaded',timeout:90000});
await p.waitForSelector('.logo-word');
await sleep(2500);
await p.screenshot({path:'shots-mobile/land-title.png'});
await click('GRAND PRIX'); await sleep(1500);
await click('CONTINUE →'); await sleep(1500);
// One lap only, so the AI reaches the results screen quickly.
for (let i=0;i<3;i++){ await p.evaluate(()=>[...document.querySelectorAll('.laps-picker button')].find(b=>b.textContent.trim()==='−')?.click()); await sleep(120); }
await click('START RACE');
await p.waitForFunction(()=>['countdown','racing'].includes(document.getElementById('ui')?.dataset.state),{timeout:120000});
console.log('racing…');
await p.waitForFunction(()=>document.getElementById('ui')?.dataset.state==='results',{timeout:300000,polling:1000});
await sleep(2500);
const probe=async(label)=>{
  await p.screenshot({path:`shots-mobile/${label}-results.png`});
  console.log(label, await p.evaluate(()=>{
    const panel=document.querySelector('.results-panel');
    const table=document.querySelector('.standings');
    const row=document.querySelector('.standing-row');
    const r=panel.getBoundingClientRect();
    return {
      viewport:[innerWidth,innerHeight],
      panel:[Math.round(r.width),Math.round(r.height),Math.round(r.x),Math.round(r.y)],
      panelOverflowsY: r.bottom>innerHeight || r.top<0,
      tableScroll:[table.scrollWidth,table.clientWidth],
      rowScroll: row?[row.scrollWidth,row.clientWidth]:null,
      docScroll:[document.documentElement.scrollWidth,innerWidth],
      rows: document.querySelectorAll('.standing-row').length,
    };
  }));
};
await probe('land');
await p.setViewport({width:390,height:844,deviceScaleFactor:2,isMobile:true,hasTouch:true,isLandscape:false});
await sleep(1200);
await probe('port');
await b.close();
