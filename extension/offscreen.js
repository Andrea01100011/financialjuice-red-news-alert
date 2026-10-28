'use strict';

let audio = null;
let lastPlayed = 0;

function play() {
  const now = Date.now();
  if (now - lastPlayed < 350) return;
  lastPlayed = now;

  if (!audio) {
    audio = new Audio('alert.wav');
    audio.preload = 'auto';
    audio.volume = 0.9;
  }
  try {
    audio.currentTime = 0;
    const promise = audio.play();
    if (promise && promise.catch) promise.catch(() => {});
  } catch (err) { /* ignore */ }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'FJ_PLAY_SOUND' || msg.target !== 'offscreen') return;
  play();
});
