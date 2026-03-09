#!/usr/bin/env node
/**
 * Generates PNG sprite sheets from the pixel-art templates defined in index.html.
 * Run once: node generate-sprites.js
 * Output: sprites/ directory with PNG files
 *
 * Sheet layout per palette: 7 columns × 1 row
 *   [WD1, WD2, TD1, TD2, RD1, RD2, IDLE(WD2)]
 *   Each frame: 16×24 pixels
 *   Sheet size: 112×24 pixels per palette
 *
 * Combined character sheet: 112 × (24 * 6) = 112 × 144 pixels
 * Plus: desk.png (32×32), pc.png (16×16), bubble_perm.png (11×13), bubble_check.png (11×13)
 */

const { PNG } = require('pngjs');
const fs = require('fs');
const path = require('path');

const SPRITES_DIR = path.join(__dirname, 'sprites');

// ================================================================
// Sprite data (mirrored from index.html)
// ================================================================
const _ = '';
const H='hair',K='skin',S='shirt',P='pants',O='shoes',E='#FFFFFF';

const PALETTES = [
  { skin:'#FFCC99', shirt:'#4488CC', pants:'#334466', hair:'#553322', shoes:'#222222' },
  { skin:'#FFCC99', shirt:'#CC4444', pants:'#333333', hair:'#FFD700', shoes:'#222222' },
  { skin:'#DEB887', shirt:'#44AA66', pants:'#334444', hair:'#222222', shoes:'#333333' },
  { skin:'#FFCC99', shirt:'#AA55CC', pants:'#443355', hair:'#AA4422', shoes:'#222222' },
  { skin:'#DEB887', shirt:'#CCAA33', pants:'#444433', hair:'#553322', shoes:'#333333' },
  { skin:'#FFCC99', shirt:'#FF8844', pants:'#443322', hair:'#111111', shoes:'#222222' },
];

function resolve(tpl, pal) {
  return tpl.map(r => r.map(c => {
    if (c === _) return '';
    if (c === E) return E;
    return pal[c] || c;
  }));
}

const WD1=[
[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
[_,_,_,_,_,_,H,H,H,H,_,_,_,_,_,_],
[_,_,_,_,_,H,H,H,H,H,H,_,_,_,_,_],
[_,_,_,_,_,H,H,H,H,H,H,_,_,_,_,_],
[_,_,_,_,_,K,K,K,K,K,K,_,_,_,_,_],
[_,_,_,_,_,K,E,K,K,E,K,_,_,_,_,_],
[_,_,_,_,_,K,K,K,K,K,K,_,_,_,_,_],
[_,_,_,_,_,K,K,K,K,K,K,_,_,_,_,_],
[_,_,_,_,_,_,S,S,S,S,_,_,_,_,_,_],
[_,_,_,_,_,S,S,S,S,S,S,_,_,_,_,_],
[_,_,_,_,S,S,S,S,S,S,S,S,_,_,_,_],
[_,_,_,_,S,S,S,S,S,S,S,S,_,_,_,_],
[_,_,_,_,K,S,S,S,S,S,S,K,_,_,_,_],
[_,_,_,_,_,S,S,S,S,S,S,_,_,_,_,_],
[_,_,_,_,_,_,P,P,P,P,_,_,_,_,_,_],
[_,_,_,_,_,P,P,P,P,P,P,_,_,_,_,_],
[_,_,_,_,_,P,P,P,P,P,P,_,_,_,_,_],
[_,_,_,_,P,P,_,_,_,_,P,P,_,_,_,_],
[_,_,_,_,P,P,_,_,_,_,P,P,_,_,_,_],
[_,_,_,_,O,O,_,_,_,_,_,O,O,_,_,_],
[_,_,_,_,O,O,_,_,_,_,_,O,O,_,_,_],
[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
];

const WD2=[
[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
[_,_,_,_,_,_,H,H,H,H,_,_,_,_,_,_],
[_,_,_,_,_,H,H,H,H,H,H,_,_,_,_,_],
[_,_,_,_,_,H,H,H,H,H,H,_,_,_,_,_],
[_,_,_,_,_,K,K,K,K,K,K,_,_,_,_,_],
[_,_,_,_,_,K,E,K,K,E,K,_,_,_,_,_],
[_,_,_,_,_,K,K,K,K,K,K,_,_,_,_,_],
[_,_,_,_,_,K,K,K,K,K,K,_,_,_,_,_],
[_,_,_,_,_,_,S,S,S,S,_,_,_,_,_,_],
[_,_,_,_,_,S,S,S,S,S,S,_,_,_,_,_],
[_,_,_,_,S,S,S,S,S,S,S,S,_,_,_,_],
[_,_,_,_,S,S,S,S,S,S,S,S,_,_,_,_],
[_,_,_,_,K,S,S,S,S,S,S,K,_,_,_,_],
[_,_,_,_,_,S,S,S,S,S,S,_,_,_,_,_],
[_,_,_,_,_,_,P,P,P,P,_,_,_,_,_,_],
[_,_,_,_,_,P,P,P,P,P,P,_,_,_,_,_],
[_,_,_,_,_,P,P,_,_,P,P,_,_,_,_,_],
[_,_,_,_,_,P,P,_,_,P,P,_,_,_,_,_],
[_,_,_,_,_,P,P,_,_,P,P,_,_,_,_,_],
[_,_,_,_,_,O,O,_,_,O,O,_,_,_,_,_],
[_,_,_,_,_,O,O,_,_,O,O,_,_,_,_,_],
[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
];

const TD1=[
[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
[_,_,_,_,_,_,H,H,H,H,_,_,_,_,_,_],
[_,_,_,_,_,H,H,H,H,H,H,_,_,_,_,_],
[_,_,_,_,_,H,H,H,H,H,H,_,_,_,_,_],
[_,_,_,_,_,K,K,K,K,K,K,_,_,_,_,_],
[_,_,_,_,_,K,E,K,K,E,K,_,_,_,_,_],
[_,_,_,_,_,K,K,K,K,K,K,_,_,_,_,_],
[_,_,_,_,_,K,K,K,K,K,K,_,_,_,_,_],
[_,_,_,_,_,_,S,S,S,S,_,_,_,_,_,_],
[_,_,_,_,_,S,S,S,S,S,S,_,_,_,_,_],
[_,_,_,_,S,S,S,S,S,S,S,S,_,_,_,_],
[_,_,_,K,K,S,S,S,S,S,S,K,K,_,_,_],
[_,_,_,_,K,S,S,S,S,S,S,K,_,_,_,_],
[_,_,_,_,_,S,S,S,S,S,S,_,_,_,_,_],
[_,_,_,_,_,_,P,P,P,P,_,_,_,_,_,_],
[_,_,_,_,_,P,P,P,P,P,P,_,_,_,_,_],
[_,_,_,_,_,P,P,P,P,P,P,_,_,_,_,_],
[_,_,_,_,_,P,P,_,_,P,P,_,_,_,_,_],
[_,_,_,_,_,O,O,_,_,O,O,_,_,_,_,_],
[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
];

const TD2=[
[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
[_,_,_,_,_,_,H,H,H,H,_,_,_,_,_,_],
[_,_,_,_,_,H,H,H,H,H,H,_,_,_,_,_],
[_,_,_,_,_,H,H,H,H,H,H,_,_,_,_,_],
[_,_,_,_,_,K,K,K,K,K,K,_,_,_,_,_],
[_,_,_,_,_,K,E,K,K,E,K,_,_,_,_,_],
[_,_,_,_,_,K,K,K,K,K,K,_,_,_,_,_],
[_,_,_,_,_,K,K,K,K,K,K,_,_,_,_,_],
[_,_,_,_,_,_,S,S,S,S,_,_,_,_,_,_],
[_,_,_,_,_,S,S,S,S,S,S,_,_,_,_,_],
[_,_,_,_,S,S,S,S,S,S,S,S,_,_,_,_],
[_,_,_,_,K,S,S,S,S,S,S,K,K,_,_,_],
[_,_,_,_,K,S,S,S,S,S,S,_,K,_,_,_],
[_,_,_,_,_,S,S,S,S,S,S,_,_,_,_,_],
[_,_,_,_,_,_,P,P,P,P,_,_,_,_,_,_],
[_,_,_,_,_,P,P,P,P,P,P,_,_,_,_,_],
[_,_,_,_,_,P,P,P,P,P,P,_,_,_,_,_],
[_,_,_,_,_,P,P,_,_,P,P,_,_,_,_,_],
[_,_,_,_,_,O,O,_,_,O,O,_,_,_,_,_],
[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
];

const RD1=[
[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
[_,_,_,_,_,_,H,H,H,H,_,_,_,_,_,_],
[_,_,_,_,_,H,H,H,H,H,H,_,_,_,_,_],
[_,_,_,_,_,H,H,H,H,H,H,_,_,_,_,_],
[_,_,_,_,_,K,K,K,K,K,K,_,_,_,_,_],
[_,_,_,_,_,K,E,K,K,E,K,_,_,_,_,_],
[_,_,_,_,_,K,K,K,K,K,K,_,_,_,_,_],
[_,_,_,_,_,K,K,K,K,K,K,_,_,_,_,_],
[_,_,_,_,_,_,S,S,S,S,_,_,_,_,_,_],
[_,_,_,_,_,S,S,S,S,S,S,_,_,_,_,_],
[_,_,_,_,S,S,S,S,S,S,S,S,_,_,_,_],
[_,_,_,_,S,S,S,S,S,S,S,S,_,_,_,_],
[_,_,_,_,K,S,S,S,S,S,S,K,_,_,_,_],
[_,_,_,_,_,S,S,S,S,S,S,_,_,_,_,_],
[_,_,_,_,_,_,P,P,P,P,_,_,_,_,_,_],
[_,_,_,_,_,P,P,P,P,P,P,_,_,_,_,_],
[_,_,_,_,_,P,P,P,P,P,P,_,_,_,_,_],
[_,_,_,_,_,P,P,_,_,P,P,_,_,_,_,_],
[_,_,_,_,_,O,O,_,_,O,O,_,_,_,_,_],
[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
];

const RD2=[
[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
[_,_,_,_,_,_,H,H,H,H,_,_,_,_,_,_],
[_,_,_,_,_,H,H,H,H,H,H,_,_,_,_,_],
[_,_,_,_,_,H,H,H,H,H,H,_,_,_,_,_],
[_,_,_,_,_,K,K,K,K,K,K,_,_,_,_,_],
[_,_,_,_,_,K,E,K,K,E,K,_,_,_,_,_],
[_,_,_,_,_,K,K,K,K,K,K,_,_,_,_,_],
[_,_,_,_,_,K,K,K,K,K,K,_,_,_,_,_],
[_,_,_,_,_,_,S,S,S,S,_,_,_,_,_,_],
[_,_,_,_,_,S,S,S,S,S,S,_,_,_,_,_],
[_,_,_,_,S,S,S,S,S,S,S,S,_,_,_,_],
[_,_,_,_,S,S,S,S,S,S,S,S,_,_,_,_],
[_,_,_,_,K,S,S,S,S,S,S,K,_,_,_,_],
[_,_,_,_,_,S,S,S,S,S,S,_,_,_,_,_],
[_,_,_,_,_,_,P,P,P,P,_,_,_,_,_,_],
[_,_,_,_,_,P,P,P,P,P,P,_,_,_,_,_],
[_,_,_,_,_,P,P,_,_,P,P,_,_,_,_,_],
[_,_,_,_,_,O,O,_,_,O,O,_,_,_,_,_],
[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
];

// Desk 32x32
const DESK = (() => {
  const W='#8B6914',L='#A07828',Sf='#B8922E',D='#6B4E0A';
  const r = [];
  r.push(Array(32).fill(''));
  r.push(['', ...Array(30).fill(W), '']);
  for(let i=0;i<4;i++) r.push(['',W,...Array(28).fill(i<1?L:Sf),W,'']);
  r.push(['',D,...Array(28).fill(W),D,'']);
  for(let i=0;i<6;i++) r.push(['',W,...Array(28).fill(Sf),W,'']);
  r.push(['',W,...Array(28).fill(L),W,'']);
  for(let i=0;i<6;i++) r.push(['',W,...Array(28).fill(Sf),W,'']);
  r.push(['',D,...Array(28).fill(W),D,'']);
  for(let i=0;i<4;i++) r.push(['',W,...Array(28).fill(i>2?L:Sf),W,'']);
  r.push(['', ...Array(30).fill(W), '']);
  for(let i=0;i<4;i++){const row=Array(32).fill('');row[1]=D;row[2]=D;row[29]=D;row[30]=D;r.push(row);}
  r.push(Array(32).fill(''));
  r.push(Array(32).fill(''));
  return r;
})();

// PC 16x16
const PC=[
[_,_,_,'#555','#555','#555','#555','#555','#555','#555','#555','#555','#555',_,_,_],
[_,_,_,'#555','#3A3A5C','#3A3A5C','#3A3A5C','#3A3A5C','#3A3A5C','#3A3A5C','#3A3A5C','#3A3A5C','#555',_,_,_],
[_,_,_,'#555','#3A3A5C','#6688CC','#6688CC','#6688CC','#6688CC','#6688CC','#6688CC','#3A3A5C','#555',_,_,_],
[_,_,_,'#555','#3A3A5C','#6688CC','#6688CC','#6688CC','#6688CC','#6688CC','#6688CC','#3A3A5C','#555',_,_,_],
[_,_,_,'#555','#3A3A5C','#6688CC','#6688CC','#6688CC','#6688CC','#6688CC','#6688CC','#3A3A5C','#555',_,_,_],
[_,_,_,'#555','#3A3A5C','#6688CC','#6688CC','#6688CC','#6688CC','#6688CC','#6688CC','#3A3A5C','#555',_,_,_],
[_,_,_,'#555','#3A3A5C','#6688CC','#6688CC','#6688CC','#6688CC','#6688CC','#6688CC','#3A3A5C','#555',_,_,_],
[_,_,_,'#555','#3A3A5C','#6688CC','#6688CC','#6688CC','#6688CC','#6688CC','#6688CC','#3A3A5C','#555',_,_,_],
[_,_,_,'#555','#3A3A5C','#3A3A5C','#3A3A5C','#3A3A5C','#3A3A5C','#3A3A5C','#3A3A5C','#3A3A5C','#555',_,_,_],
[_,_,_,'#555','#555','#555','#555','#555','#555','#555','#555','#555','#555',_,_,_],
[_,_,_,_,_,_,_,'#444','#444',_,_,_,_,_,_,_],
[_,_,_,_,_,_,_,'#444','#444',_,_,_,_,_,_,_],
[_,_,_,_,_,_,'#444','#444','#444','#444',_,_,_,_,_,_],
[_,_,_,_,_,'#444','#444','#444','#444','#444','#444',_,_,_,_,_],
[_,_,_,_,_,'#444','#444','#444','#444','#444','#444',_,_,_,_,_],
[_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
];

// Speech bubbles
const BUBBLE_PERM = [
['#556','#556','#556','#556','#556','#556','#556','#556','#556','#556','#556'],
['#556','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#556'],
['#556','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#556'],
['#556','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#556'],
['#556','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#556'],
['#556','#EEF','#EEF','#CCA700','#EEF','#CCA700','#EEF','#CCA700','#EEF','#EEF','#556'],
['#556','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#556'],
['#556','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#556'],
['#556','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#556'],
['#556','#556','#556','#556','#556','#556','#556','#556','#556','#556','#556'],
[_,_,_,_,'#556','#556','#556',_,_,_,_],
[_,_,_,_,_,'#556',_,_,_,_,_],
[_,_,_,_,_,_,_,_,_,_,_],
];

const BUBBLE_CHECK = [
[_,'#556','#556','#556','#556','#556','#556','#556','#556','#556',_],
['#556','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#556'],
['#556','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#556'],
['#556','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#4B6','#EEF','#556'],
['#556','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#4B6','#EEF','#EEF','#556'],
['#556','#EEF','#EEF','#4B6','#EEF','#EEF','#4B6','#EEF','#EEF','#EEF','#556'],
['#556','#EEF','#EEF','#EEF','#4B6','#4B6','#EEF','#EEF','#EEF','#EEF','#556'],
['#556','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#556'],
['#556','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#EEF','#556'],
[_,'#556','#556','#556','#556','#556','#556','#556','#556','#556',_],
[_,_,_,_,'#556','#556','#556',_,_,_,_],
[_,_,_,_,_,'#556',_,_,_,_,_],
[_,_,_,_,_,_,_,_,_,_,_],
];

// ================================================================
// Color parsing
// ================================================================
function parseHexColor(hex) {
  if (!hex || hex === '') return null;
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
  if (hex.length === 6) {
    return {
      r: parseInt(hex.substring(0, 2), 16),
      g: parseInt(hex.substring(2, 4), 16),
      b: parseInt(hex.substring(4, 6), 16),
      a: 255,
    };
  }
  return null;
}

// ================================================================
// PNG generation helpers
// ================================================================
function createPNG(width, height) {
  const png = new PNG({ width, height, filterType: -1 });
  // Initialize to transparent
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 0;
    png.data[i + 1] = 0;
    png.data[i + 2] = 0;
    png.data[i + 3] = 0;
  }
  return png;
}

function drawSpriteOnPNG(png, data, offsetX, offsetY) {
  const rows = data.length;
  const cols = data[0].length;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const color = data[r][c];
      if (!color) continue;
      const parsed = parseHexColor(color);
      if (!parsed) continue;
      const x = offsetX + c;
      const y = offsetY + r;
      if (x < 0 || x >= png.width || y < 0 || y >= png.height) continue;
      const idx = (y * png.width + x) * 4;
      png.data[idx] = parsed.r;
      png.data[idx + 1] = parsed.g;
      png.data[idx + 2] = parsed.b;
      png.data[idx + 3] = parsed.a;
    }
  }
}

function savePNG(png, filename) {
  const filePath = path.join(SPRITES_DIR, filename);
  const buffer = PNG.sync.write(png);
  fs.writeFileSync(filePath, buffer);
  console.log(`  Generated: ${filename} (${png.width}x${png.height})`);
}

// ================================================================
// Body type variant generators (mirrored from index.html)
// ================================================================
function cloneTemplate(tpl) { return tpl.map(r => [...r]); }

function makeLongHair(tpl) {
  const t = cloneTemplate(tpl);
  for (let r = 0; r < t.length; r++) {
    if (t[r].includes(H)) {
      for (let fr = r + 3; fr < Math.min(r + 8, t.length); fr++) {
        if (t[fr][4] === _ && (t[fr][5] === K || t[fr][5] === S || t[fr][5] === _)) t[fr][4] = H;
        if (t[fr][11] === _ && (t[fr][10] === K || t[fr][10] === S || t[fr][10] === _)) t[fr][11] = H;
      }
      break;
    }
  }
  return t;
}

function makeCap(tpl) {
  const t = cloneTemplate(tpl);
  const G = '#hat';
  for (let r = 0; r < t.length; r++) {
    if (t[r].includes(H)) {
      if (r > 0) {
        t[r - 1] = t[r - 1].map((c, i) => (i >= 4 && i <= 12) ? G : c);
      }
      t[r] = t[r].map((c, i) => c === H ? G : c);
      if (r + 1 < t.length) {
        t[r + 1] = t[r + 1].map((c, i) => c === H ? G : c);
      }
      break;
    }
  }
  return t;
}

function resolveVariant(tpl, pal) {
  return tpl.map(r => r.map(c => {
    if (c === _) return '';
    if (c === E) return E;
    if (c === '#hat') return pal[S];
    return pal[c] || c;
  }));
}

// Body types: 0=default, 1=long hair, 2=cap
const BODY_TYPES = [
  { walk1: WD1, walk2: WD2, type1: TD1, type2: TD2, read1: RD1, read2: RD2 },
  { walk1: makeLongHair(WD1), walk2: makeLongHair(WD2), type1: makeLongHair(TD1), type2: makeLongHair(TD2), read1: makeLongHair(RD1), read2: makeLongHair(RD2) },
  { walk1: makeCap(WD1), walk2: makeCap(WD2), type1: makeCap(TD1), type2: makeCap(TD2), read1: makeCap(RD1), read2: makeCap(RD2) },
];
const NUM_BODY_TYPES = BODY_TYPES.length;

// ================================================================
// Generate character sprite sheets
// ================================================================
// Layout: 7 frames per row, (6 palettes × 3 body types) rows
// Row index = paletteIdx * NUM_BODY_TYPES + bodyTypeIdx
// Each frame: 16x24
const FRAME_W = 16;
const FRAME_H = 24;
const FRAME_KEYS = ['walk1', 'walk2', 'type1', 'type2', 'read1', 'read2', 'walk2']; // 7th = idle (walk2)
const FRAME_NAMES = ['walk1', 'walk2', 'type1', 'type2', 'read1', 'read2', 'idle'];
const NUM_FRAMES = FRAME_KEYS.length;
const TOTAL_ROWS = PALETTES.length * NUM_BODY_TYPES;

console.log('Generating sprite sheets...\n');
console.log(`  Body types: ${NUM_BODY_TYPES} (default, long hair, cap)`);
console.log(`  Palettes: ${PALETTES.length}`);
console.log(`  Total character rows: ${TOTAL_ROWS}\n`);

// Combined character sheet
const charSheet = createPNG(NUM_FRAMES * FRAME_W, TOTAL_ROWS * FRAME_H);

for (let p = 0; p < PALETTES.length; p++) {
  const pal = PALETTES[p];
  for (let b = 0; b < NUM_BODY_TYPES; b++) {
    const bt = BODY_TYPES[b];
    const rowIdx = p * NUM_BODY_TYPES + b;
    for (let f = 0; f < NUM_FRAMES; f++) {
      const tpl = bt[FRAME_KEYS[f]];
      const data = resolveVariant(tpl, pal);
      drawSpriteOnPNG(charSheet, data, f * FRAME_W, rowIdx * FRAME_H);
    }
  }
}
savePNG(charSheet, 'characters.png');

// Individual sheets per palette+bodyType for artistic editing
for (let p = 0; p < PALETTES.length; p++) {
  const pal = PALETTES[p];
  for (let b = 0; b < NUM_BODY_TYPES; b++) {
    const bt = BODY_TYPES[b];
    const sheet = createPNG(NUM_FRAMES * FRAME_W, FRAME_H);
    for (let f = 0; f < NUM_FRAMES; f++) {
      const tpl = bt[FRAME_KEYS[f]];
      const data = resolveVariant(tpl, pal);
      drawSpriteOnPNG(sheet, data, f * FRAME_W, 0);
    }
    savePNG(sheet, `character_${p}_${b}.png`);
  }
}

// Desk
const deskPng = createPNG(32, 32);
drawSpriteOnPNG(deskPng, DESK, 0, 0);
savePNG(deskPng, 'desk.png');

// PC
const pcPng = createPNG(16, 16);
drawSpriteOnPNG(pcPng, PC, 0, 0);
savePNG(pcPng, 'pc.png');

// Bubbles
const bpPng = createPNG(11, 13);
drawSpriteOnPNG(bpPng, BUBBLE_PERM, 0, 0);
savePNG(bpPng, 'bubble_perm.png');

const bcPng = createPNG(11, 13);
drawSpriteOnPNG(bcPng, BUBBLE_CHECK, 0, 0);
savePNG(bcPng, 'bubble_check.png');

console.log('\nDone! Sprite sheets saved to sprites/');
console.log('\nSheet layout (characters.png):');
console.log('  Columns: ' + FRAME_NAMES.join(', '));
console.log(`  Rows: ${TOTAL_ROWS} (${PALETTES.length} palettes × ${NUM_BODY_TYPES} body types)`);
console.log('  Row index = paletteIdx * NUM_BODY_TYPES + bodyTypeIdx');
console.log(`  Frame size: ${FRAME_W}x${FRAME_H}`);
console.log(`  Sheet size: ${NUM_FRAMES * FRAME_W}x${TOTAL_ROWS * FRAME_H}`);
