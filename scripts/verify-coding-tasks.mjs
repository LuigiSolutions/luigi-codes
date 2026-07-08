#!/usr/bin/env node
// Phase 0.5 gate: verify every NEW hard coding task before it enters eval/tasks/coding.json.
// For each task we ship a correct reference (`ref`) and a plausible-but-wrong stub (`wrong`).
// A task is admissible ONLY if: ref PASSES the task's tests AND wrong FAILS them (the tests
// discriminate correct from incorrect). Mirrors the double-check discipline of the
// reasoning-with-code generator. Run: node scripts/verify-coding-tasks.mjs [--emit]
//
// --emit prints the clean task objects (id/difficulty/entryPoint/prompt/tests[/holdout]) as
// JSON so they can be merged into coding.json. Without --emit it just reports PASS/FAIL.

const NEW_TASKS = [
  {
    id: 'code-h7-longest-palindrome',
    difficulty: 'hard',
    entryPoint: 'longestPalindrome',
    prompt: "Write a JavaScript function `longestPalindrome(s)` that returns the longest contiguous substring of s that is a palindrome. If several have the same maximal length, any one of them is acceptable. Return only the function.",
    // Tie-agnostic: result must itself be a palindrome, be a substring of s, and match the known max length.
    tests: "function isPal(x){return x===x.split('').reverse().join('');} function chk(s,len){const r=longestPalindrome(s); if(typeof r!=='string')throw new Error('not string:'+s); if(!isPal(r))throw new Error('not palindrome:'+s+'->'+r); if(!s.includes(r))throw new Error('not substring:'+s+'->'+r); if(r.length!==len)throw new Error('len '+s+'->'+r+' want '+len);} chk('babad',3); chk('cbbd',2); chk('a',1); chk('ac',1); chk('forgeeksskeegfor',10);",
    ref: "function longestPalindrome(s){if(s.length<2)return s;let best='';const exp=(l,r)=>{while(l>=0&&r<s.length&&s[l]===s[r]){l--;r++;}return s.slice(l+1,r);};for(let i=0;i<s.length;i++){const a=exp(i,i),b=exp(i,i+1);if(a.length>best.length)best=a;if(b.length>best.length)best=b;}return best;}",
    wrong: "function longestPalindrome(s){return s.length?s[0]:'';}",
  },
  {
    id: 'code-h8-word-break',
    difficulty: 'hard',
    entryPoint: 'wordBreak',
    prompt: "Write a JavaScript function `wordBreak(s, wordDict)` that returns true if s can be segmented into a space-separated sequence of one or more words from the array wordDict (each word may be reused). Return only the function.",
    tests: "if(wordBreak('leetcode',['leet','code'])!==true)throw new Error('t1'); if(wordBreak('applepenapple',['apple','pen'])!==true)throw new Error('t2'); if(wordBreak('catsandog',['cats','dog','sand','and','cat'])!==false)throw new Error('t3'); if(wordBreak('',['a'])!==true)throw new Error('t4'); if(wordBreak('aaaaaaa',['aaaa','aaa'])!==true)throw new Error('t5');",
    ref: "function wordBreak(s,wordDict){const set=new Set(wordDict);const dp=new Array(s.length+1).fill(false);dp[0]=true;for(let i=1;i<=s.length;i++){for(let j=0;j<i;j++){if(dp[j]&&set.has(s.slice(j,i))){dp[i]=true;break;}}}return dp[s.length];}",
    wrong: "function wordBreak(s,wordDict){const set=new Set(wordDict);return s===''||set.has(s);}",
  },
  {
    id: 'code-h9-lis',
    difficulty: 'hard',
    entryPoint: 'lengthOfLIS',
    prompt: "Write a JavaScript function `lengthOfLIS(nums)` that returns the length of the longest strictly increasing subsequence of the array nums. Return only the function.",
    tests: "if(lengthOfLIS([10,9,2,5,3,7,101,18])!==4)throw new Error('t1'); if(lengthOfLIS([0,1,0,3,2,3])!==4)throw new Error('t2'); if(lengthOfLIS([7,7,7,7])!==1)throw new Error('t3'); if(lengthOfLIS([])!==0)throw new Error('t4'); if(lengthOfLIS([4,10,4,3,8,9])!==3)throw new Error('t5');",
    ref: "function lengthOfLIS(nums){const tails=[];for(const x of nums){let lo=0,hi=tails.length;while(lo<hi){const m=(lo+hi)>>1;if(tails[m]<x)lo=m+1;else hi=m;}tails[lo]=x;}return tails.length;}",
    wrong: "function lengthOfLIS(nums){return nums.length?[...new Set(nums)].length:0;}",
  },
  {
    id: 'code-h10-jump-game',
    difficulty: 'hard',
    entryPoint: 'canJump',
    prompt: "Write a JavaScript function `canJump(nums)` where nums[i] is the maximum jump length from index i. Return true if you can reach the last index starting from index 0, else false. Return only the function.",
    tests: "if(canJump([2,3,1,1,4])!==true)throw new Error('t1'); if(canJump([3,2,1,0,4])!==false)throw new Error('t2'); if(canJump([0])!==true)throw new Error('t3'); if(canJump([2,0,0])!==true)throw new Error('t4'); if(canJump([1,0,1,0])!==false)throw new Error('t5');",
    ref: "function canJump(nums){let reach=0;for(let i=0;i<nums.length;i++){if(i>reach)return false;reach=Math.max(reach,i+nums[i]);}return true;}",
    wrong: "function canJump(nums){return nums[0]>=nums.length-1;}",
  },
  {
    id: 'code-h11-num-islands',
    difficulty: 'hard',
    entryPoint: 'numIslands',
    prompt: "Write a JavaScript function `numIslands(grid)` that takes a 2D array of '1' (land) and '0' (water) strings and returns the number of islands. An island is land connected 4-directionally (up/down/left/right). Return only the function.",
    tests: "const g1=[['1','1','0','0'],['1','0','0','1'],['0','0','1','1']]; if(numIslands(g1)!==2)throw new Error('t1'); const g2=[['1','1','1'],['0','1','0'],['1','1','1']]; if(numIslands(g2)!==1)throw new Error('t2'); if(numIslands([['0','0'],['0','0']])!==0)throw new Error('t3'); if(numIslands([['1']])!==1)throw new Error('t4');",
    ref: "function numIslands(grid){const R=grid.length,C=R?grid[0].length:0;const seen=grid.map(r=>r.map(()=>false));let n=0;const dfs=(r,c)=>{if(r<0||c<0||r>=R||c>=C||seen[r][c]||grid[r][c]!=='1')return;seen[r][c]=true;dfs(r+1,c);dfs(r-1,c);dfs(r,c+1);dfs(r,c-1);};for(let r=0;r<R;r++)for(let c=0;c<C;c++){if(grid[r][c]==='1'&&!seen[r][c]){n++;dfs(r,c);}}return n;}",
    wrong: "function numIslands(grid){let n=0;for(const row of grid)for(const c of row)if(c==='1')n++;return n;}",
  },
  {
    id: 'code-h12-decode-string',
    difficulty: 'hard',
    entryPoint: 'decodeString',
    prompt: "Write a JavaScript function `decodeString(s)` that decodes a string encoded as k[encoded], meaning the encoded substring repeats k times. k is a positive integer; brackets may be nested. Example: '3[a2[c]]' decodes to 'accaccacc'. Return only the function.",
    tests: "if(decodeString('3[a]2[bc]')!=='aaabcbc')throw new Error('t1'); if(decodeString('3[a2[c]]')!=='accaccacc')throw new Error('t2'); if(decodeString('2[abc]3[cd]ef')!=='abcabccdcdcdef')throw new Error('t3'); if(decodeString('abc')!=='abc')throw new Error('t4'); if(decodeString('10[a]')!=='aaaaaaaaaa')throw new Error('t5');",
    ref: "function decodeString(s){const numSt=[],strSt=[];let cur='',num=0;for(const ch of s){if(ch>='0'&&ch<='9'){num=num*10+(+ch);}else if(ch==='['){numSt.push(num);strSt.push(cur);num=0;cur='';}else if(ch===']'){const k=numSt.pop();cur=strSt.pop()+cur.repeat(k);}else{cur+=ch;}}return cur;}",
    wrong: "function decodeString(s){return s.replace(/(\\d+)\\[([a-z]*)\\]/g,(_,k,t)=>t.repeat(+k));}",
  },
  {
    id: 'code-h13-course-schedule',
    difficulty: 'hard',
    entryPoint: 'canFinish',
    prompt: "Write a JavaScript function `canFinish(numCourses, prerequisites)` where prerequisites[i] = [a, b] means course a depends on course b. Return true if all courses can be finished (the dependency graph has no cycle), else false. Return only the function.",
    tests: "if(canFinish(2,[[1,0]])!==true)throw new Error('t1'); if(canFinish(2,[[1,0],[0,1]])!==false)throw new Error('t2'); if(canFinish(3,[[0,1],[1,2],[2,0]])!==false)throw new Error('t3'); if(canFinish(4,[[1,0],[2,0],[3,1],[3,2]])!==true)throw new Error('t4'); if(canFinish(1,[])!==true)throw new Error('t5');",
    ref: "function canFinish(numCourses,prerequisites){const adj=Array.from({length:numCourses},()=>[]);const indeg=new Array(numCourses).fill(0);for(const[a,b]of prerequisites){adj[b].push(a);indeg[a]++;}const q=[];for(let i=0;i<numCourses;i++)if(indeg[i]===0)q.push(i);let seen=0;while(q.length){const u=q.shift();seen++;for(const v of adj[u])if(--indeg[v]===0)q.push(v);}return seen===numCourses;}",
    wrong: "function canFinish(numCourses,prerequisites){return prerequisites.length<numCourses;}",
  },
  {
    id: 'code-h14-product-except-self',
    difficulty: 'hard',
    entryPoint: 'productExceptSelf',
    prompt: "Write a JavaScript function `productExceptSelf(nums)` that returns an array out where out[i] is the product of every element of nums except nums[i]. Do it without using the division operator. Return only the function.",
    tests: "function eq(a,b){return JSON.stringify(a)===JSON.stringify(b);} if(!eq(productExceptSelf([1,2,3,4]),[24,12,8,6]))throw new Error('t1'); if(!eq(productExceptSelf([-1,1,0,-3,3]),[0,0,9,0,0]))throw new Error('t2'); if(!eq(productExceptSelf([2,3]),[3,2]))throw new Error('t3'); if(!eq(productExceptSelf([5]),[1]))throw new Error('t4');",
    ref: "function productExceptSelf(nums){const n=nums.length,out=new Array(n).fill(1);let p=1;for(let i=0;i<n;i++){out[i]=p;p*=nums[i];}p=1;for(let i=n-1;i>=0;i--){out[i]*=p;p*=nums[i];}return out;}",
    wrong: "function productExceptSelf(nums){const total=nums.reduce((a,b)=>a*b,1);return nums.map(x=>total/x);}",
  },
  {
    id: 'code-h15-search-rotated',
    difficulty: 'hard',
    entryPoint: 'searchRotated',
    prompt: "Write a JavaScript function `searchRotated(nums, target)` that searches for target in an ascending array that has been rotated at an unknown pivot (all values distinct). Return its index, or -1 if absent. Aim for O(log n). Return only the function.",
    tests: "if(searchRotated([4,5,6,7,0,1,2],0)!==4)throw new Error('t1'); if(searchRotated([4,5,6,7,0,1,2],3)!==-1)throw new Error('t2'); if(searchRotated([1],1)!==0)throw new Error('t3'); if(searchRotated([5,1,3],5)!==0)throw new Error('t4'); if(searchRotated([],1)!==-1)throw new Error('t5'); if(searchRotated([6,7,8,1,2,3,4,5],8)!==2)throw new Error('t6');",
    ref: "function searchRotated(nums,target){let lo=0,hi=nums.length-1;while(lo<=hi){const m=(lo+hi)>>1;if(nums[m]===target)return m;if(nums[lo]<=nums[m]){if(nums[lo]<=target&&target<nums[m])hi=m-1;else lo=m+1;}else{if(nums[m]<target&&target<=nums[hi])lo=m+1;else hi=m-1;}}return -1;}",
    wrong: "function searchRotated(nums,target){let lo=0,hi=nums.length-1;while(lo<=hi){const m=(lo+hi)>>1;if(nums[m]===target)return m;if(nums[m]<target)lo=m+1;else hi=m-1;}return -1;}",
  },

  // ---- HOLDOUT (never seen by the optimization loop / hyperparameter selection) ----
  {
    id: 'code-hold-c1-max-profit-2',
    difficulty: 'hard',
    holdout: true,
    entryPoint: 'maxProfit',
    prompt: "Write a JavaScript function `maxProfit(prices)` where prices[i] is a stock price on day i. Return the maximum profit from at most TWO buy-sell transactions (you must sell before buying again). Return only the function.",
    tests: "if(maxProfit([3,3,5,0,0,3,1,4])!==6)throw new Error('t1'); if(maxProfit([1,2,3,4,5])!==4)throw new Error('t2'); if(maxProfit([7,6,4,3,1])!==0)throw new Error('t3'); if(maxProfit([1,2,4,2,5,7,2,4,9,0])!==13)throw new Error('t4'); if(maxProfit([])!==0)throw new Error('t5');",
    ref: "function maxProfit(prices){let b1=-Infinity,s1=0,b2=-Infinity,s2=0;for(const p of prices){b1=Math.max(b1,-p);s1=Math.max(s1,b1+p);b2=Math.max(b2,s1-p);s2=Math.max(s2,b2+p);}return s2;}",
    wrong: "function maxProfit(prices){let mn=Infinity,best=0;for(const p of prices){mn=Math.min(mn,p);best=Math.max(best,p-mn);}return best;}",
  },
  {
    id: 'code-hold-c2-min-path-sum',
    difficulty: 'hard',
    holdout: true,
    entryPoint: 'minPathSum',
    prompt: "Write a JavaScript function `minPathSum(grid)` that returns the minimum sum of a path from the top-left to the bottom-right of a 2D grid of non-negative numbers, moving only right or down. Return only the function.",
    tests: "if(minPathSum([[1,3,1],[1,5,1],[4,2,1]])!==7)throw new Error('t1'); if(minPathSum([[1,2,3],[4,5,6]])!==12)throw new Error('t2'); if(minPathSum([[5]])!==5)throw new Error('t3'); if(minPathSum([[1,2],[1,1]])!==3)throw new Error('t4');",
    ref: "function minPathSum(grid){const R=grid.length,C=grid[0].length;const dp=grid.map(r=>r.slice());for(let r=0;r<R;r++)for(let c=0;c<C;c++){if(r===0&&c===0)continue;const up=r>0?dp[r-1][c]:Infinity;const left=c>0?dp[r][c-1]:Infinity;dp[r][c]+=Math.min(up,left);}return dp[R-1][C-1];}",
    wrong: "function minPathSum(grid){let s=0,r=0,c=0;const R=grid.length,C=grid[0].length;s=grid[0][0];while(r<R-1||c<C-1){const down=r<R-1?grid[r+1][c]:Infinity;const right=c<C-1?grid[r][c+1]:Infinity;if(down<=right){r++;}else{c++;}s+=grid[r][c];}return s;}",
  },
  {
    id: 'code-hold-c3-unique-paths-obstacles',
    difficulty: 'hard',
    holdout: true,
    entryPoint: 'uniquePathsWithObstacles',
    prompt: "Write a JavaScript function `uniquePathsWithObstacles(grid)` counting distinct paths from top-left to bottom-right of a 2D grid, moving only right or down, where grid cells with value 1 are obstacles (impassable) and 0 are free. Return only the function.",
    tests: "if(uniquePathsWithObstacles([[0,0,0],[0,1,0],[0,0,0]])!==2)throw new Error('t1'); if(uniquePathsWithObstacles([[0,1],[0,0]])!==1)throw new Error('t2'); if(uniquePathsWithObstacles([[1]])!==0)throw new Error('t3'); if(uniquePathsWithObstacles([[0,0],[1,1],[0,0]])!==0)throw new Error('t4'); if(uniquePathsWithObstacles([[0]])!==1)throw new Error('t5');",
    ref: "function uniquePathsWithObstacles(grid){const R=grid.length,C=grid[0].length;const dp=Array.from({length:R},()=>new Array(C).fill(0));for(let r=0;r<R;r++)for(let c=0;c<C;c++){if(grid[r][c]===1){dp[r][c]=0;continue;}if(r===0&&c===0){dp[r][c]=1;continue;}dp[r][c]=(r>0?dp[r-1][c]:0)+(c>0?dp[r][c-1]:0);}return dp[R-1][C-1];}",
    wrong: "function uniquePathsWithObstacles(grid){const R=grid.length,C=grid[0].length;const f=(m,n)=>{let r=1;for(let i=1;i<n;i++)r=r*(m-1+i)/i;return Math.round(r);};return f(R,C);}",
  },
];

function runTests(fnSource, tests) {
  try {
    // Build a module: define the function, then run the assertions. Throw = fail.
    // eslint-disable-next-line no-new-func
    const f = new Function(`${fnSource}\n${tests}\nreturn true;`);
    f();
    return { ok: true, err: '' };
  } catch (e) {
    return { ok: false, err: String(e && e.message || e) };
  }
}

let allGood = true;
const clean = [];
for (const t of NEW_TASKS) {
  const okRef = runTests(t.ref, t.tests);
  const okWrong = runTests(t.wrong, t.tests);
  const refPass = okRef.ok;
  const wrongFail = !okWrong.ok;
  const admissible = refPass && wrongFail;
  if (!admissible) allGood = false;
  const tag = admissible ? 'OK  ' : 'FAIL';
  console.log(`${tag} ${t.id}${t.holdout ? ' [holdout]' : ''}  ref=${refPass ? 'pass' : 'FAIL(' + okRef.err + ')'}  wrong=${wrongFail ? 'fails-as-expected' : 'PASSED-BUG(' + (okWrong.ok ? 'no-throw' : okWrong.err) + ')'}`);
  if (admissible) {
    const obj = { id: t.id, difficulty: t.difficulty, entryPoint: t.entryPoint, prompt: t.prompt, tests: t.tests };
    if (t.holdout) obj.holdout = true;
    clean.push(obj);
  }
}

console.log(`\n${clean.length}/${NEW_TASKS.length} admissible.`);
if (process.argv.includes('--emit')) {
  console.log('\n----EMIT----');
  console.log(JSON.stringify(clean, null, 2));
}
process.exit(allGood ? 0 : 1);
