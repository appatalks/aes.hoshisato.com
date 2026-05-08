'use strict';

(function () {
  var inputEl  = document.getElementById('InputText');
  var keyEl    = document.getElementById('EncryptionKey');
  var bitEl    = document.getElementById('Bit');
  var outputEl = document.getElementById('OutputText');
  var resultEl = document.getElementById('ResultContainer');
  var encBtn   = document.getElementById('EncryptButton');
  var decBtn   = document.getElementById('DecryptButton');
  var copyBtn  = document.getElementById('CopyButton');

  function showResult(text) {
    outputEl.textContent = text;
    resultEl.hidden = false;
  }

  function showError(msg) {
    outputEl.textContent = '\u26a0\ufe0f ' + msg;
    resultEl.hidden = false;
  }

  function keyBits() {
    return parseInt(bitEl.value, 10);
  }

  function setLoading(btn, loading) {
    btn.disabled = loading;
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.textContent = loading ? 'Working\u2026' : btn.dataset.label;
  }

  if (!window.crypto || !window.crypto.subtle) {
    showError('Web Crypto API is not available. Use a modern browser over HTTPS.');
    encBtn.disabled = true;
    decBtn.disabled = true;
    return;
  }

  encBtn.addEventListener('click', function () {
    var text = inputEl.value;
    var pass = keyEl.value;
    if (!text) { showError('Enter text to encrypt.'); return; }
    if (!pass) { showError('Enter a password.'); return; }
    setLoading(encBtn, true);
    AES.encrypt(text, pass, keyBits()).then(function (result) {
      showResult(result);
    }).catch(function (e) {
      showError('Encryption failed: ' + e.message);
    }).then(function () {
      setLoading(encBtn, false);
    });
  });

  decBtn.addEventListener('click', function () {
    var text = inputEl.value;
    var pass = keyEl.value;
    if (!text) { showError('Enter ciphertext to decrypt.'); return; }
    if (!pass) { showError('Enter a password.'); return; }
    setLoading(decBtn, true);
    AES.decrypt(text, pass, keyBits()).then(function (result) {
      showResult(result);
    }).catch(function () {
      showError('Decryption failed. Wrong password, wrong key size, or invalid ciphertext.');
    }).then(function () {
      setLoading(decBtn, false);
    });
  });

  copyBtn.addEventListener('click', function () {
    var text = outputEl.textContent;
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        var orig = copyBtn.textContent;
        copyBtn.textContent = 'Copied!';
        setTimeout(function () { copyBtn.textContent = orig; }, 2000);
      }).catch(function () { fallbackSelect(); });
    } else {
      fallbackSelect();
    }
  });

  function fallbackSelect() {
    var range = document.createRange();
    range.selectNodeContents(outputEl);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
}());