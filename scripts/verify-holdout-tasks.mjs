#!/usr/bin/env node
// Phase 0.5 gate for the never-seen HOLDOUT reserve in the reasoning_code and reasoning suites.
// Same discipline as the main generators:
//   - reasoning_code holdout: two independent references (ref, ref2) must AGREE on a batch of
//     inputs, ref must PASS the task tests, and a wrong stub must FAIL them.
//   - reasoning holdout: the numeric answer is DOUBLE-DERIVED (two independent computations must
//     agree); we never hand-type an answer we did not compute two ways.
// Run: node scripts/verify-holdout-tasks.mjs [--emit]

// ---------------- reasoning_code holdout ----------------
const RC_HOLDOUT = [
  {
    id: 'rc-hold1-josephus',
    difficulty: 'hard',
    entryPoint: 'josephus',
    prompt: "Write a JavaScript function `josephus(n, k)` that returns the 1-indexed position of the survivor in the Josephus problem: n people stand in a circle numbered 1..n, and every k-th person is eliminated (counting starts at person 1) until one remains. Return only the function.",
    ref: "function josephus(n,k){let r=0;for(let i=2;i<=n;i++)r=(r+k)%i;return r+1;}",
    ref2: "function josephus(n,k){const a=[];for(let i=1;i<=n;i++)a.push(i);let idx=0;while(a.length>1){idx=(idx+k-1)%a.length;a.splice(idx,1);}return a[0];}",
    wrong: "function josephus(n,k){return ((n-1)%k)+1;}",
    inputs: [[1,1],[5,2],[7,3],[10,2],[41,3],[6,4]],
  },
  {
    id: 'rc-hold2-nth-ugly',
    difficulty: 'hard',
    entryPoint: 'nthUgly',
    prompt: "Write a JavaScript function `nthUgly(n)` that returns the nth ugly number (1-indexed). Ugly numbers are positive integers whose only prime factors are 2, 3, or 5. By convention 1 is the first ugly number. Return only the function.",
    ref: "function nthUgly(n){const u=[1];let i2=0,i3=0,i5=0;while(u.length<n){const nx=Math.min(u[i2]*2,u[i3]*3,u[i5]*5);u.push(nx);if(nx===u[i2]*2)i2++;if(nx===u[i3]*3)i3++;if(nx===u[i5]*5)i5++;}return u[n-1];}",
    ref2: "function nthUgly(n){const isUgly=(x)=>{for(const p of [2,3,5])while(x%p===0)x/=p;return x===1;};let c=0,x=0;while(c<n){x++;if(isUgly(x))c++;}return x;}",
    wrong: "function nthUgly(n){return n;}",
    inputs: [[1],[7],[10],[11],[15]],
  },
  {
    id: 'rc-hold3-collatz-steps',
    difficulty: 'hard',
    entryPoint: 'collatzSteps',
    prompt: "Write a JavaScript function `collatzSteps(n)` that returns how many steps it takes to reach 1 from n under the Collatz process: if the current value is even, halve it; if odd, triple it and add one. collatzSteps(1) is 0. Return only the function.",
    ref: "function collatzSteps(n){let s=0;while(n!==1){n=n%2===0?n/2:3*n+1;s++;}return s;}",
    ref2: "function collatzSteps(n){let s=0;while(n>1){if((n&1)===0)n=Math.floor(n/2);else n=n*3+1;s++;}return s;}",
    wrong: "function collatzSteps(n){return n-1;}",
    inputs: [[1],[6],[7],[27],[97]],
  },
];

// ---------------- reasoning holdout (double-derived numeric answers) ----------------
const REASON_HOLDOUT = [
  {
    id: 'reason-hold1-div3or5',
    difficulty: 'expert',
    type: 'number',
    prompt: "How many positive integers strictly less than 1000 are divisible by 3 or by 5? End with a line 'Final answer: X'.",
    // method A: inclusion-exclusion; method B: brute count
    deriveA: () => Math.floor(999 / 3) + Math.floor(999 / 5) - Math.floor(999 / 15),
    deriveB: () => { let c = 0; for (let i = 1; i < 1000; i++) if (i % 3 === 0 || i % 5 === 0) c++; return c; },
  },
  {
    id: 'reason-hold2-modpow',
    difficulty: 'expert',
    type: 'number',
    prompt: "What is the remainder when 7^100 is divided by 13? End with a line 'Final answer: X'.",
    // method A: fast modpow; method B: iterative product mod 13
    deriveA: () => { let r = 1, b = 7 % 13, e = 100; while (e > 0) { if (e & 1) r = (r * b) % 13; b = (b * b) % 13; e >>= 1; } return r; },
    deriveB: () => { let r = 1; for (let i = 0; i < 100; i++) r = (r * 7) % 13; return r; },
  },
  {
    id: 'reason-hold3-arith-series',
    difficulty: 'expert',
    type: 'number',
    prompt: "Consider the arithmetic sequence whose first term is 4 and whose common difference is 6 (so 4, 10, 16, ...). What is the sum of its first 20 terms? End with a line 'Final answer: X'.",
    // method A: closed form n/2*(2a+(n-1)d); method B: summation
    deriveA: () => (20 / 2) * (2 * 4 + (20 - 1) * 6),
    deriveB: () => { let s = 0; for (let i = 0; i < 20; i++) s += 4 + i * 6; return s; },
  },
];

function runTests(fnSource, tests) {
  try { new Function(`${fnSource}\n${tests}\nreturn true;`)(); return { ok: true, err: '' }; }
  catch (e) { return { ok: false, err: String((e && e.message) || e) }; }
}

// Build a tests string for a reasoning_code task from ref over its inputs (the ground truth).
function buildTests(entryPoint, ref, inputs) {
  // eslint-disable-next-line no-new-func
  const fn = new Function(`${ref}\nreturn ${entryPoint};`)();
  const parts = inputs.map((args, i) => {
    const exp = fn(...args);
    const call = `${entryPoint}(${args.map((a) => JSON.stringify(a)).join(',')})`;
    return `{ const got = ${call}; const exp = ${JSON.stringify(exp)}; if (got !== exp) throw new Error('${entryPoint} case ${i}: expected ' + exp + ' got ' + got); }`;
  });
  return parts.join(' ');
}

let allGood = true;
const rcClean = [];
console.log('== reasoning_code holdout ==');
for (const t of RC_HOLDOUT) {
  // 1. ref and ref2 must agree on every input.
  const f1 = new Function(`${t.ref}\nreturn ${t.entryPoint};`)();
  const f2 = new Function(`${t.ref2}\nreturn ${t.entryPoint};`)();
  let agree = true, disagreeAt = '';
  for (const args of t.inputs) {
    const a = f1(...args), b = f2(...args);
    if (a !== b) { agree = false; disagreeAt = `${JSON.stringify(args)} -> ${a} vs ${b}`; break; }
  }
  const tests = buildTests(t.entryPoint, t.ref, t.inputs);
  const refPass = runTests(t.ref, tests).ok;
  const wrongFail = !runTests(t.wrong, tests).ok;
  const ok = agree && refPass && wrongFail;
  if (!ok) allGood = false;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${t.id}  agree=${agree ? 'yes' : 'NO(' + disagreeAt + ')'}  ref=${refPass ? 'pass' : 'FAIL'}  wrong=${wrongFail ? 'fails-as-expected' : 'PASSED-BUG'}`);
  if (ok) rcClean.push({ id: t.id, difficulty: t.difficulty, holdout: true, entryPoint: t.entryPoint, prompt: t.prompt, tests });
}

const rClean = [];
console.log('\n== reasoning holdout (double-derived) ==');
for (const t of REASON_HOLDOUT) {
  const a = t.deriveA(), b = t.deriveB();
  const ok = a === b && Number.isFinite(a);
  if (!ok) allGood = false;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${t.id}  A=${a} B=${b} ${a === b ? '(agree)' : '(DISAGREE)'}`);
  if (ok) rClean.push({ id: t.id, difficulty: t.difficulty, holdout: true, prompt: t.prompt, answer: String(a), type: t.type });
}

console.log(`\nreasoning_code holdout: ${rcClean.length}/${RC_HOLDOUT.length} admissible; reasoning holdout: ${rClean.length}/${REASON_HOLDOUT.length} admissible.`);
if (process.argv.includes('--emit')) {
  console.log('\n----EMIT-RC----');
  console.log(JSON.stringify(rcClean, null, 2));
  console.log('\n----EMIT-REASON----');
  console.log(JSON.stringify(rClean, null, 2));
}
process.exit(allGood ? 0 : 1);
