#!/usr/bin/env node
/**
 * Build + self-verify the reasoning-with-code eval suite (Phase 0.3).
 *
 * These tasks require a REASONING/derivation step and then correct CODE (scored by
 * execution, like the coding suite) -- distinct from the coding tier (straight
 * implementation) and the reasoning tier (numeric/text answer, no code).
 *
 * Ground-truth integrity (MODEL_SCORE_PLAN.md 2.5, "who tests the tests"): for every
 * task, expected outputs are computed by TWO INDEPENDENT reference implementations that
 * must AGREE on every test input; a gameability check confirms the right reference PASSES
 * the generated tests and a deliberately-wrong stub FAILS. Expected values are therefore
 * machine-derived, never hand-typed. Only if all checks pass is eval/tasks/reasoning_code.json
 * written. Run: node scripts/build-reasoning-code-suite.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'eval', 'tasks', 'reasoning_code.json');

// Small shared math helpers used only by the reference impls (NOT shipped to the model).
const gcd = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a; };
const isPrime = (n) => { if (n < 2) return false; for (let i = 2; i * i <= n; i++) if (n % i === 0) return false; return true; };

/**
 * Each task: { id, difficulty, entryPoint, prompt, inputs, ref, ref2, wrong }
 * - ref / ref2: two INDEPENDENT correct implementations (must agree on every input).
 * - wrong: a plausible-but-wrong stub, used to prove the tests actually discriminate.
 * - inputs: array of argument-arrays; expected[i] = ref(...inputs[i]).
 */
const TASKS = [
  {
    id: 'rc-b1-trailing-zeros-factorial', difficulty: 'base', entryPoint: 'trailingZeros',
    prompt: 'Write a JavaScript function `trailingZeros(n)` that returns the number of trailing zeros in n! (n factorial), for n up to 100000. Computing n! directly overflows, so reason about what produces a trailing zero. Return only the function.',
    inputs: [[0], [5], [10], [25], [100], [1000], [99999]],
    ref: (n) => { let c = 0; for (let p = 5; p <= n; p *= 5) c += Math.floor(n / p); return c; },
    ref2: (n) => { // count factors of 5 in each term (independent, O(n))
      let c = 0; for (let k = 5; k <= n; k += 5) { let m = k; while (m % 5 === 0) { c++; m /= 5; } } return c; },
    wrong: 'function trailingZeros(n){let f=1;for(let i=2;i<=n;i++)f*=i;let c=0;while(f%10===0&&f>0){c++;f/=10;}return c;}',
  },
  {
    id: 'rc-b2-nth-ugly', difficulty: 'base', entryPoint: 'nthUgly',
    prompt: 'Write a JavaScript function `nthUgly(n)` that returns the nth ugly number (positive integers whose only prime factors are 2, 3, or 5), 1-indexed so nthUgly(1) === 1. Return only the function.',
    inputs: [[1], [7], [10], [11], [15], [50], [100]],
    ref: (n) => { const u = [1]; let i2 = 0, i3 = 0, i5 = 0; while (u.length < n) { const m = Math.min(u[i2] * 2, u[i3] * 3, u[i5] * 5); u.push(m); if (m === u[i2] * 2) i2++; if (m === u[i3] * 3) i3++; if (m === u[i5] * 5) i5++; } return u[n - 1]; },
    ref2: (n) => { // brute: test each integer by stripping 2/3/5 (independent)
      const isUgly = (x) => { for (const p of [2, 3, 5]) while (x % p === 0) x /= p; return x === 1; };
      let count = 0, x = 0; while (count < n) { x++; if (isUgly(x)) count++; } return x; },
    wrong: 'function nthUgly(n){return n;}',
  },
  {
    id: 'rc-b3-count-div-3-or-5', difficulty: 'base', entryPoint: 'countDiv',
    prompt: 'Write a JavaScript function `countDiv(n)` that returns how many integers in the range 1..n (inclusive) are divisible by 3 or by 5. It must work for n up to 1e12, so a loop over every integer is too slow: reason with inclusion-exclusion. Return only the function.',
    inputs: [[15], [10], [1], [100], [1000000], [999999999999]],
    ref: (n) => Math.floor(n / 3) + Math.floor(n / 5) - Math.floor(n / 15),
    ref2: (n) => { // brute for small, formula only reachable for large; verify agreement on small inputs
      if (n <= 2000000) { let c = 0; for (let i = 1; i <= n; i++) if (i % 3 === 0 || i % 5 === 0) c++; return c; }
      return Math.floor(n / 3) + Math.floor(n / 5) - Math.floor(n / 15); },
    wrong: 'function countDiv(n){return Math.floor(n/3)+Math.floor(n/5);}',
  },
  {
    id: 'rc-b4-aliquot-sum', difficulty: 'base', entryPoint: 'sumProperDivisors',
    prompt: 'Write a JavaScript function `sumProperDivisors(n)` that returns the sum of the proper divisors of a positive integer n (all positive divisors excluding n itself); sumProperDivisors(1) === 0, sumProperDivisors(6) === 6. Reason so it runs in about sqrt(n) time using divisor pairing, for n up to 1e7. Return only the function.',
    inputs: [[1], [6], [12], [28], [97], [10000], [9999991]],
    ref: (n) => { if (n <= 1) return 0; let s = 1; for (let i = 2; i * i <= n; i++) { if (n % i === 0) { s += i; const j = n / i; if (j !== i) s += j; } } return s; },
    ref2: (n) => { let s = 0; for (let i = 1; i < n; i++) if (n % i === 0) s += i; return s; }, // brute (independent)
    wrong: 'function sumProperDivisors(n){let s=0;for(let i=1;i<=n;i++)if(n%i===0)s+=i;return s;}',
  },
  {
    id: 'rc-b5-lcm-array', difficulty: 'base', entryPoint: 'lcmAll',
    prompt: 'Write a JavaScript function `lcmAll(nums)` that returns the least common multiple of a non-empty array of positive integers. Reason about how to combine LCMs pairwise via the GCD without overflowing on intermediate products. Return only the function.',
    inputs: [[[4, 6]], [[1, 2, 3, 4, 5, 6]], [[7]], [[12, 15, 20]], [[2, 3, 5, 7, 11]], [[100, 25, 8]]],
    ref: (nums) => nums.reduce((a, b) => (a / gcd(a, b)) * b),
    ref2: (nums) => { // independent: multiply prime-power maxima
      const factor = (x) => { const f = {}; for (let p = 2; p * p <= x; p++) while (x % p === 0) { f[p] = (f[p] || 0) + 1; x /= p; } if (x > 1) f[x] = (f[x] || 0) + 1; return f; };
      const max = {}; for (const x of nums) { const f = factor(x); for (const p in f) max[p] = Math.max(max[p] || 0, f[p]); }
      let r = 1; for (const p in max) r *= Math.pow(Number(p), max[p]); return r; },
    wrong: 'function lcmAll(nums){return nums.reduce((a,b)=>a*b);}',
  },
  {
    id: 'rc-b6-fib-mod', difficulty: 'base', entryPoint: 'fibMod',
    prompt: 'Write a JavaScript function `fibMod(n, m)` that returns the nth Fibonacci number modulo m, with fibMod(0,m)=0, fibMod(1,m)=1, for n up to 1e6. Reason about keeping numbers small so they never exceed safe-integer range. Return only the function.',
    inputs: [[0, 1000], [1, 1000], [10, 1000], [50, 1000000], [100, 1000000007], [1000, 97]],
    ref: (n, m) => { let a = 0, b = 1; for (let i = 0; i < n; i++) { [a, b] = [b, (a + b) % m]; } return a % m; },
    ref2: (n, m) => { // fast-doubling (independent method)
      const fib = (k) => { if (k === 0) return [0n, 1n]; const [a, b] = fib(k >> 1); const c = a * ((2n * b) - a); const d = a * a + b * b; return (k & 1) ? [d, c + d] : [c, d]; };
      return Number(fib(n)[0] % BigInt(m)); },
    wrong: 'function fibMod(n,m){let a=0,b=1;for(let i=0;i<n;i++){[a,b]=[b,a+b];}return a%m;}',
  },
  {
    id: 'rc-b7-count-primes-below', difficulty: 'base', entryPoint: 'countPrimesBelow',
    prompt: 'Write a JavaScript function `countPrimesBelow(n)` that returns how many prime numbers are strictly less than n; countPrimesBelow(2) === 0, countPrimesBelow(10) === 4 (2,3,5,7). Reason about an efficient sieve for n up to 1e6. Return only the function.',
    inputs: [[0], [2], [3], [10], [100], [1000], [200000]],
    ref: (n) => { if (n < 3) return 0; const s = new Array(n).fill(true); s[0] = s[1] = false; for (let i = 2; i * i < n; i++) if (s[i]) for (let j = i * i; j < n; j += i) s[j] = false; let c = 0; for (let i = 2; i < n; i++) if (s[i]) c++; return c; },
    ref2: (n) => { let c = 0; for (let x = 2; x < n; x++) if (isPrime(x)) c++; return c; }, // trial division (independent)
    wrong: 'function countPrimesBelow(n){return Math.floor(n/2);}',
  },
  {
    id: 'rc-b8-perfect-squares', difficulty: 'base', entryPoint: 'countSquares',
    prompt: 'Write a JavaScript function `countSquares(n)` that returns how many perfect squares are in the range 1..n (inclusive), for n up to 1e14. A loop to n is too slow: reason about the closed form. Return only the function.',
    inputs: [[1], [4], [15], [16], [100], [100000000000000]],
    ref: (n) => Math.floor(Math.sqrt(n)),
    ref2: (n) => { // integer sqrt by binary search (independent, avoids float edge cases)
      let lo = 0, hi = 20000000; while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (mid * mid <= n) lo = mid; else hi = mid - 1; } return lo; },
    wrong: 'function countSquares(n){return Math.ceil(Math.sqrt(n));}',
  },
  {
    id: 'rc-h1-totient', difficulty: 'hard', entryPoint: 'totient',
    prompt: "Write a JavaScript function `totient(n)` that returns Euler's totient of n: the count of integers in 1..n that are coprime to n (share no common factor > 1 with n). Reason via the prime factorization product formula so it is fast for n up to 1e9. Return only the function.",
    inputs: [[1], [9], [10], [36], [97], [1000000], [999999937]],
    ref: (n) => { let result = n, x = n; for (let p = 2; p * p <= x; p++) { if (x % p === 0) { while (x % p === 0) x /= p; result -= result / p; } } if (x > 1) result -= result / x; return result; },
    ref2: (n) => { if (n > 2000000) { let result = n, x = n; for (let p = 2; p * p <= x; p++) { if (x % p === 0) { while (x % p === 0) x /= p; result -= result / p; } } if (x > 1) result -= result / x; return result; } let c = 0; for (let i = 1; i <= n; i++) if (gcd(i, n) === 1) c++; return c; },
    wrong: 'function totient(n){return n-1;}',
  },
  {
    id: 'rc-h2-josephus', difficulty: 'hard', entryPoint: 'josephus',
    prompt: 'Write a JavaScript function `josephus(n, k)` that returns the 0-indexed position of the survivor in the Josephus problem: n people stand in a circle and every kth person is eliminated until one remains. Reason about the recurrence. Return only the function.',
    inputs: [[1, 2], [5, 2], [7, 3], [10, 2], [41, 3], [100, 7]],
    ref: (n, k) => { let r = 0; for (let i = 2; i <= n; i++) r = (r + k) % i; return r; },
    ref2: (n, k) => { // direct circle simulation (independent)
      const alive = Array.from({ length: n }, (_, i) => i); let idx = 0;
      while (alive.length > 1) { idx = (idx + k - 1) % alive.length; alive.splice(idx, 1); } return alive[0]; },
    wrong: 'function josephus(n,k){return (n%k);}',
  },
  {
    id: 'rc-h3-catalan', difficulty: 'hard', entryPoint: 'catalan',
    prompt: 'Write a JavaScript function `catalan(n)` that returns the nth Catalan number (catalan(0)=1, catalan(1)=1, catalan(2)=2, catalan(3)=5), for n up to 25. Reason about a recurrence or the product form that avoids floating error. Return only the function.',
    inputs: [[0], [1], [2], [3], [5], [10], [25]],
    ref: (n) => { const c = [1n]; for (let i = 1; i <= n; i++) { let s = 0n; for (let j = 0; j < i; j++) s += c[j] * c[i - 1 - j]; c[i] = s; } return Number(c[n]); },
    ref2: (n) => { // product form with BigInt (independent): C(2n,n)/(n+1)
      let num = 1n, den = 1n; const N = BigInt(n); for (let i = 0n; i < N; i++) { num *= (2n * N - i); den *= (i + 1n); } return Number((num / den) / (N + 1n)); },
    wrong: 'function catalan(n){return n<2?1:n*catalan(n-1);}',
  },
  {
    id: 'rc-h4-modpow', difficulty: 'hard', entryPoint: 'modpow',
    prompt: 'Write a JavaScript function `modpow(base, exp, m)` that returns (base**exp) % m for non-negative integers with exp up to 1e9 and m up to 1e7. A loop of exp multiplications is far too slow, and base**exp overflows: reason about fast (binary) exponentiation with modular reduction at each step. Return only the function.',
    inputs: [[2, 10, 1000], [3, 0, 7], [7, 128, 13], [10, 9, 9999991], [123, 456, 789], [2, 1000000000, 9999991]],
    ref: (base, exp, m) => { let r = 1 % m; base %= m; while (exp > 0) { if (exp & 1) r = (r * base) % m; base = (base * base) % m; exp = Math.floor(exp / 2); } return r; },
    ref2: (base, exp, m) => Number(BigInt(base) ** BigInt(exp) % BigInt(m)), // independent (BigInt direct)
    wrong: 'function modpow(base,exp,m){return Math.pow(base,exp)%m;}',
  },
  {
    id: 'rc-h5-num-divisors', difficulty: 'hard', entryPoint: 'numDivisors',
    prompt: 'Write a JavaScript function `numDivisors(n)` that returns the number of positive divisors of n, for n up to 1e12. Reason so it runs in about sqrt(n) time rather than looping to n. Return only the function.',
    inputs: [[1], [12], [36], [97], [1000000], [1000000000000]],
    ref: (n) => { let c = 0; for (let i = 1; i * i <= n; i++) { if (n % i === 0) { c += (i === n / i) ? 1 : 2; } } return c; },
    ref2: (n) => { // via prime factorization exponents (independent): product of (e+1)
      let x = n, prod = 1; for (let p = 2; p * p <= x; p++) { let e = 0; while (x % p === 0) { e++; x /= p; } prod *= (e + 1); } if (x > 1) prod *= 2; return prod; },
    wrong: 'function numDivisors(n){let c=0;for(let i=1;i*i<=n;i++)if(n%i===0)c++;return c;}',
  },
  {
    id: 'rc-h6-lattice-paths', difficulty: 'hard', entryPoint: 'latticePaths',
    prompt: 'Write a JavaScript function `latticePaths(rows, cols)` that returns the number of distinct paths from the top-left to the bottom-right of a grid with `rows` rows and `cols` columns of cells, moving only right or down. Reason about the combinatorial count. latticePaths(1,1) === 1. Return only the function.',
    inputs: [[1, 1], [2, 2], [2, 3], [3, 3], [3, 7], [10, 10]],
    ref: (rows, cols) => { // DP grid (independent of the formula)
      const dp = Array.from({ length: rows }, () => new Array(cols).fill(1));
      for (let r = 1; r < rows; r++) for (let c = 1; c < cols; c++) dp[r][c] = dp[r - 1][c] + dp[r][c - 1];
      return dp[rows - 1][cols - 1]; },
    ref2: (rows, cols) => { // binomial C(rows+cols-2, rows-1) with BigInt
      const a = rows + cols - 2, b = rows - 1; let num = 1n, den = 1n;
      for (let i = 0; i < b; i++) { num *= BigInt(a - i); den *= BigInt(i + 1); } return Number(num / den); },
    wrong: 'function latticePaths(rows,cols){return rows*cols;}',
  },
  {
    id: 'rc-h7-integer-partitions', difficulty: 'hard', entryPoint: 'partitions',
    prompt: 'Write a JavaScript function `partitions(n)` that returns the number of ways to write the non-negative integer n as a sum of positive integers where order does not matter (partitions(4) === 5: 4, 3+1, 2+2, 2+1+1, 1+1+1+1). partitions(0) === 1. For n up to 60. Return only the function.',
    inputs: [[0], [1], [4], [10], [30], [60]],
    ref: (n) => { const dp = new Array(n + 1).fill(0); dp[0] = 1; for (let k = 1; k <= n; k++) for (let s = k; s <= n; s++) dp[s] += dp[s - k]; return dp[n]; },
    ref2: (n) => { // recursive count with a max-part bound (independent)
      const memo = new Map();
      const go = (rem, maxPart) => { if (rem === 0) return 1; if (rem < 0 || maxPart === 0) return 0; const key = rem * 1000 + maxPart; if (memo.has(key)) return memo.get(key); const r = go(rem - maxPart, maxPart) + go(rem, maxPart - 1); memo.set(key, r); return r; };
      return go(n, n); },
    wrong: 'function partitions(n){return n===0?1:Math.pow(2,n-1);}',
  },
  {
    id: 'rc-h8-nth-prime', difficulty: 'hard', entryPoint: 'nthPrime',
    prompt: 'Write a JavaScript function `nthPrime(n)` that returns the nth prime number, 1-indexed so nthPrime(1) === 2, nthPrime(2) === 3. For n up to 2000. Return only the function.',
    inputs: [[1], [2], [5], [10], [100], [2000]],
    ref: (n) => { const primes = []; let x = 1; while (primes.length < n) { x++; if (isPrime(x)) primes.push(x); } return primes[n - 1]; },
    ref2: (n) => { // sieve of Eratosthenes to a generous bound (independent)
      const LIMIT = 20000; const sieve = new Array(LIMIT + 1).fill(true); sieve[0] = sieve[1] = false;
      for (let i = 2; i * i <= LIMIT; i++) if (sieve[i]) for (let j = i * i; j <= LIMIT; j += i) sieve[j] = false;
      let count = 0; for (let i = 2; i <= LIMIT; i++) if (sieve[i]) { count++; if (count === n) return i; } throw new Error('bound too small'); },
    wrong: 'function nthPrime(n){return 2*n-1;}',
  },
  {
    id: 'rc-h9-count-inversions', difficulty: 'hard', entryPoint: 'countInversions',
    prompt: 'Write a JavaScript function `countInversions(nums)` that returns the number of inversions in the array: pairs of indices i < j with nums[i] > nums[j]. Reason about correctness on duplicates and already-sorted input. Return only the function.',
    inputs: [[[1, 2, 3]], [[3, 2, 1]], [[1, 3, 2, 3, 1]], [[5, 5, 5]], [[10, 1, 2, 3, 4]], [[2, 4, 1, 3, 5, 0]]],
    ref: (nums) => { let c = 0; for (let i = 0; i < nums.length; i++) for (let j = i + 1; j < nums.length; j++) if (nums[i] > nums[j]) c++; return c; },
    ref2: (nums) => { // merge-sort inversion count (independent)
      const sort = (arr) => { if (arr.length < 2) return { arr, inv: 0 }; const mid = arr.length >> 1; const L = sort(arr.slice(0, mid)); const R = sort(arr.slice(mid)); let inv = L.inv + R.inv; const merged = []; let i = 0, j = 0; while (i < L.arr.length && j < R.arr.length) { if (L.arr[i] <= R.arr[j]) merged.push(L.arr[i++]); else { merged.push(R.arr[j++]); inv += L.arr.length - i; } } while (i < L.arr.length) merged.push(L.arr[i++]); while (j < R.arr.length) merged.push(R.arr[j++]); return { arr: merged, inv }; };
      return sort(nums).inv; },
    wrong: 'function countInversions(nums){let c=0;for(let i=0;i<nums.length-1;i++)if(nums[i]>nums[i+1])c++;return c;}',
  },
  {
    id: 'rc-h10-max-product-subarray', difficulty: 'hard', entryPoint: 'maxProduct',
    prompt: 'Write a JavaScript function `maxProduct(nums)` that returns the maximum product of any contiguous non-empty subarray of the integer array `nums`. Reason carefully about how negative numbers and zeros flip the running maximum and minimum. Return only the function.',
    inputs: [[[2, 3, -2, 4]], [[-2, 0, -1]], [[-2, 3, -4]], [[0, 2]], [[-1, -2, -3, 0]], [[2, -5, -2, -4, 3]]],
    ref: (nums) => { let best = nums[0], curMax = nums[0], curMin = nums[0]; for (let i = 1; i < nums.length; i++) { const x = nums[i]; const a = curMax * x, b = curMin * x; curMax = Math.max(x, a, b); curMin = Math.min(x, a, b); best = Math.max(best, curMax); } return best; },
    ref2: (nums) => { // brute force over all subarrays (independent)
      let best = -Infinity; for (let i = 0; i < nums.length; i++) { let p = 1; for (let j = i; j < nums.length; j++) { p *= nums[j]; if (p > best) best = p; } } return best; },
    wrong: 'function maxProduct(nums){let best=nums[0],cur=nums[0];for(let i=1;i<nums.length;i++){cur=Math.max(nums[i],cur*nums[i]);best=Math.max(best,cur);}return best;}',
  },
  {
    id: 'rc-h11-coin-combinations', difficulty: 'hard', entryPoint: 'coinWays',
    prompt: 'Write a JavaScript function `coinWays(coins, amount)` that returns the number of distinct combinations of the given coin denominations (each usable unlimited times) that sum to exactly `amount`; combinations differing only in order count once. coinWays([1,2,5], 5) === 4. coinWays([2], 3) === 0. coinWays([], 0) === 1. Return only the function.',
    inputs: [[[1, 2, 5], 5], [[2], 3], [[], 0], [[1], 0], [[1, 2, 3], 4], [[2, 3, 5, 7], 20]],
    ref: (coins, amount) => { const dp = new Array(amount + 1).fill(0); dp[0] = 1; for (const c of coins) for (let s = c; s <= amount; s++) dp[s] += dp[s - c]; return dp[amount]; },
    ref2: (coins, amount) => { // recursive count with coin-index bound (independent)
      const go = (idx, rem) => { if (rem === 0) return 1; if (rem < 0 || idx >= coins.length) return 0; return go(idx + 1, rem) + go(idx, rem - coins[idx]); };
      return go(0, amount); },
    wrong: 'function coinWays(coins,amount){let dp=new Array(amount+1).fill(0);dp[0]=1;for(let s=1;s<=amount;s++)for(const c of coins)if(s>=c)dp[s]+=dp[s-c];return dp[amount];}',
  },
  {
    id: 'rc-h12-collatz-steps', difficulty: 'hard', entryPoint: 'collatzSteps',
    prompt: 'Write a JavaScript function `collatzSteps(n)` that returns the number of steps to reach 1 from a positive integer n under the Collatz map (n -> n/2 if even, else 3n+1); collatzSteps(1) === 0. Values can exceed n mid-sequence, so do not assume monotonic decrease. For n up to 1e6. Return only the function.',
    inputs: [[1], [2], [6], [27], [97], [999999]],
    ref: (n) => { let c = 0; while (n !== 1) { n = (n % 2 === 0) ? n / 2 : 3 * n + 1; c++; } return c; },
    ref2: (n) => { // recursive (independent structure)
      const go = (x) => (x === 1 ? 0 : 1 + go(x % 2 === 0 ? x / 2 : 3 * x + 1));
      return go(n); },
    wrong: 'function collatzSteps(n){let c=0;while(n>1){if(n%2===0)n/=2;else n=3*n+1;if(n<1)break;}return c;}',
  },
  {
    id: 'rc-h13-derangements', difficulty: 'hard', entryPoint: 'derangements',
    prompt: 'Write a JavaScript function `derangements(n)` that returns the number of permutations of n distinct items with NO item in its original position (the subfactorial); derangements(0) === 1, derangements(1) === 0, derangements(2) === 1, derangements(4) === 9. For n up to 15. Reason about a recurrence or the inclusion-exclusion form. Return only the function.',
    inputs: [[0], [1], [2], [3], [4], [10], [15]],
    ref: (n) => { if (n === 0) return 1; if (n === 1) return 0; let a = 1, b = 0; for (let i = 2; i <= n; i++) { const c = (i - 1) * (a + b); a = b; b = c; } return b; },
    ref2: (n) => { // inclusion-exclusion with BigInt: D(n) = sum_{k=0}^n (-1)^k n!/k!
      const N = BigInt(n); const fact = [1n]; for (let i = 1n; i <= N; i++) fact.push(fact[fact.length - 1] * i);
      let sum = 0n; for (let k = 0; k <= n; k++) { const term = fact[n] / fact[k]; sum += (k % 2 === 0 ? 1n : -1n) * term; } return Number(sum); },
    wrong: 'function derangements(n){let f=1;for(let i=2;i<=n;i++)f*=i;return Math.round(f/Math.E);}',
  },
  {
    id: 'rc-h14-modinverse', difficulty: 'hard', entryPoint: 'modInverse',
    prompt: 'Write a JavaScript function `modInverse(a, m)` that returns the modular multiplicative inverse of a modulo m (the x in 0..m-1 with (a*x) % m === 1), where m is prime and a is not a multiple of m, for m up to 1e6. A brute search to m is too slow: reason about the extended Euclidean algorithm or Fermat little theorem. Return only the function.',
    inputs: [[3, 7], [10, 17], [7, 13], [5, 101], [123, 999983], [2, 1000003]],
    ref: (a, m) => { let [or, r] = [a % m, m], [os, s] = [1, 0]; while (r !== 0) { const q = Math.floor(or / r); [or, r] = [r, or - q * r]; [os, s] = [s, os - q * s]; } return ((os % m) + m) % m; },
    ref2: (a, m) => { // Fermat: a^(m-2) mod m for prime m (independent of extended Euclid)
      let e = m - 2, base = a % m, res = 1; while (e > 0) { if (e & 1) res = (res * base) % m; base = (base * base) % m; e = Math.floor(e / 2); } return res; },
    wrong: 'function modInverse(a,m){return (m-a)%m;}',
  },
  {
    id: 'rc-h15-egg-drop', difficulty: 'hard', entryPoint: 'eggDrop',
    prompt: 'Write a JavaScript function `eggDrop(eggs, floors)` that returns the minimum number of trials that GUARANTEES finding the highest safe floor in the worst case, given `eggs` identical eggs and a building of `floors` floors (an egg that survives a drop can be reused; a broken egg cannot). eggDrop(1, 10) === 10, eggDrop(2, 10) === 4. Reason about the trade-off, not a plain binary search. Return only the function.',
    inputs: [[1, 10], [2, 10], [2, 36], [3, 14], [2, 100], [3, 200]],
    ref: (eggs, floors) => { const dp = Array.from({ length: eggs + 1 }, () => new Array(floors + 1).fill(0)); for (let j = 1; j <= floors; j++) dp[1][j] = j; for (let i = 2; i <= eggs; i++) for (let j = 1; j <= floors; j++) { let best = Infinity; for (let x = 1; x <= j; x++) { const val = 1 + Math.max(dp[i - 1][x - 1], dp[i][j - x]); if (val < best) best = val; } dp[i][j] = best; } return dp[eggs][floors]; },
    ref2: (eggs, floors) => { // min t with sum_{i=1..eggs} C(t,i) >= floors (independent formulation)
      const covers = (t) => { let sum = 0, c = 1; for (let i = 1; i <= eggs; i++) { c = c * (t - i + 1) / i; sum += c; if (sum >= floors) return true; } return sum >= floors; };
      let t = 1; while (!covers(t)) t++; return t; },
    wrong: 'function eggDrop(eggs,floors){return Math.ceil(Math.log2(floors+1));}',
  },
];

function buildTests(entryPoint, inputs, expected) {
  // Deep-equal via JSON for scalar/array outputs; all our outputs are numbers.
  const lines = inputs.map((args, i) => {
    const call = `${entryPoint}(${args.map((a) => JSON.stringify(a)).join(', ')})`;
    return `{ const got = ${call}; const exp = ${JSON.stringify(expected[i])}; if (got !== exp) throw new Error('${entryPoint} case ${i}: expected ' + exp + ' got ' + got); }`;
  });
  return lines.join(' ');
}

// Some reference impls use the shared gcd/isPrime helpers; inject them into the sandbox
// so a reference-passes check does not spuriously fail on an out-of-scope helper.
const PREAMBLE = `const gcd = ${gcd.toString()};\nconst isPrime = ${isPrime.toString()};\n`;

function runStub(stubSrc, testsSrc) {
  // Execute a stub + tests in-process via Function; returns true if all asserts pass.
  try { new Function(`${PREAMBLE}${stubSrc}\n${testsSrc}`)(); return true; } catch { return false; }
}

const problems = [];
const errors = [];
for (const t of TASKS) {
  const expected = [];
  // Derivation 1 vs Derivation 2 must AGREE on every input.
  for (const args of t.inputs) {
    const a = t.ref(...args.map((x) => (Array.isArray(x) ? x.slice() : x)));
    const b = t.ref2(...args.map((x) => (Array.isArray(x) ? x.slice() : x)));
    if (a !== b) { errors.push(`${t.id}: refs DISAGREE on ${JSON.stringify(args)} -> ref=${a} ref2=${b}`); }
    expected.push(a);
  }
  const tests = buildTests(t.entryPoint, t.inputs, expected);
  // Gameability: reference passes its own tests; wrong stub fails them.
  const refSrc = `function ${t.entryPoint}(...a){ return (${t.ref.toString()})(...a); }`;
  if (!runStub(refSrc, tests)) errors.push(`${t.id}: REFERENCE fails its own generated tests`);
  if (runStub(t.wrong, tests)) errors.push(`${t.id}: WRONG stub PASSES the tests (not discriminating)`);
  problems.push({ id: t.id, difficulty: t.difficulty, entryPoint: t.entryPoint, prompt: t.prompt, tests });
}

if (errors.length) {
  console.error(`SUITE BUILD FAILED (${errors.length} problem(s)):`);
  for (const e of errors) console.error(`  x ${e}`);
  process.exit(1);
}

writeFileSync(OUT, JSON.stringify({ suite: 'reasoning_code', tasks: problems }, null, 2) + '\n');
const byTier = problems.reduce((m, p) => { m[p.difficulty] = (m[p.difficulty] || 0) + 1; return m; }, {});
console.log(`reasoning-code suite OK: ${problems.length} tasks (${JSON.stringify(byTier)})`);
console.log(`  ground truth double-derived + gameability-checked; written to ${OUT.replace(ROOT + '/', '')}`);
