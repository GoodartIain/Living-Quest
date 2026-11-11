// Dice formulas rolled on the server: "1d20+5", "2d6 + 1d4 - 1", "d20". Advantage/disadvantage applies to a lone d20.
'use strict';
const crypto = require('node:crypto');

const TERM = /([+-])\s*(?:(\d*)d(\d+)|(\d+))/gy;

function parse(formula) {
  const src = String(formula).trim().toLowerCase();
  if (!src || src.length > 100) throw Object.assign(new Error('formula must be 1..100 characters'), { status: 400 });
  const s = /^[+-]/.test(src) ? src : '+' + src;
  const terms = [];
  TERM.lastIndex = 0;
  for (let m; TERM.lastIndex < s.length;) {
    while (s[TERM.lastIndex] === ' ') TERM.lastIndex++;
    const at = TERM.lastIndex;
    if (!(m = TERM.exec(s))) throw Object.assign(new Error(`cannot read "${formula}" at "${s.slice(at)}"`), { status: 400 });
    const sign = m[1] === '-' ? -1 : 1;
    if (m[4] !== undefined) terms.push({ sign, flat: Number(m[4]) });
    else terms.push({ sign, count: m[2] === '' ? 1 : Number(m[2]), sides: Number(m[3]) });
  }
  const dice = terms.filter((t) => t.sides !== undefined);
  if (terms.length > 20 || dice.some((t) => t.count < 1 || t.count > 100 || t.sides < 2 || t.sides > 1000) ||
    terms.some((t) => t.flat > 10000)) {
    throw Object.assign(new Error('at most 20 terms, 1..100 dice of 2..1000 sides'), { status: 400 });
  }
  return terms;
}

// mode: 'normal' | 'advantage' | 'disadvantage'. rng(n) returns an integer in 1..n (injectable for tests).
function roll(formula, mode = 'normal', rng = (n) => crypto.randomInt(1, n + 1)) {
  const terms = parse(formula);
  const d20 = terms.filter((t) => t.sides === 20 && t.count === 1);
  if (mode !== 'normal' && d20.length !== 1) throw Object.assign(new Error('advantage and disadvantage need exactly one 1d20 term'), { status: 400 });
  let total = 0;
  const parts = terms.map((t) => {
    if (t.flat !== undefined) { total += t.sign * t.flat; return { sign: t.sign, flat: t.flat }; }
    let rolls = Array.from({ length: t.count }, () => rng(t.sides));
    let kept = rolls;
    if (t === d20[0] && mode !== 'normal') {
      rolls = [rolls[0], rng(20)];
      kept = [mode === 'advantage' ? Math.max(...rolls) : Math.min(...rolls)];
    }
    const sum = kept.reduce((a, b) => a + b, 0);
    total += t.sign * sum;
    return { sign: t.sign, dice: `${t.count}d${t.sides}`, rolls, ...(kept.length < rolls.length && { kept }), sum };
  });
  return { formula: String(formula).trim(), mode, total, parts };
}

module.exports = { roll, parse };
