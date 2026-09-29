'use strict';

(function () {
  var inputEl  = document.getElementById('InputText');
  var keyEl    = document.getElementById('EncryptionKey');
  var keyLabelEl = document.querySelector('label[for="EncryptionKey"]');
  var bitEl    = document.getElementById('Bit');
  var outputEl = document.getElementById('OutputText');
  var resultEl = document.getElementById('ResultContainer');
  var encBtn   = document.getElementById('EncryptButton');
  var decBtn   = document.getElementById('DecryptButton');
  var copyBtn  = document.getElementById('CopyButton');
  var modeInputs = document.querySelectorAll('input[name="EncryptionMode"]');
  var keyPanel = document.getElementById('SecurityKeyPanel');
  var pairKeyBtn = document.getElementById('PairKeyButton');
  var keyStatus = document.getElementById('SecurityKeyStatus');
  var credentialStorageKey = 'aes-hoshisato-prf-credential-v1:' + location.hostname;
  var pairedCredentialId = null;

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

  function bytesFrom(value) {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    throw new Error('Invalid binary value.');
  }

  function randomBytes(length) {
    return window.crypto.getRandomValues(new Uint8Array(length));
  }

  function toBase64Url(value) {
    var bytes = bytesFrom(value);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  }

  function fromBase64Url(value) {
    if (typeof value !== 'string' || !value || !/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new Error('Invalid security key credential ID.');
    }
    var base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function isWebAuthnAvailable() {
    return window.isSecureContext && window.PublicKeyCredential && navigator.credentials &&
      typeof navigator.credentials.create === 'function' &&
      typeof navigator.credentials.get === 'function';
  }

  function readPairedCredentialId() {
    try {
      var value = window.localStorage.getItem(credentialStorageKey);
      if (!value) return null;
      var bytes = fromBase64Url(value);
      return bytes.length > 0 && bytes.length <= 1023 ? value : null;
    } catch (e) {
      return null;
    }
  }

  function savePairedCredentialId(value) {
    try {
      window.localStorage.setItem(credentialStorageKey, value);
      return true;
    } catch (e) {
      return false;
    }
  }

  function setKeyStatus(message, state) {
    keyStatus.textContent = message;
    keyStatus.dataset.state = state || 'ready';
  }

  function selectedEncryptionMode() {
    var selected = document.querySelector('input[name="EncryptionMode"]:checked');
    return selected ? selected.value : 'password';
  }

  function refreshPasswordLabel() {
    var optional = selectedEncryptionMode() === 'security-key' ||
      AES.isHardwareCiphertext(inputEl.value);
    keyLabelEl.textContent = optional ? 'Password (optional)' : 'Password';
  }

  function refreshKeyPanel() {
    var enabled = selectedEncryptionMode() === 'security-key';
    keyPanel.hidden = !enabled;
    if (!enabled) return;

    if (!isWebAuthnAvailable()) {
      pairKeyBtn.disabled = true;
      setKeyStatus('Security-key mode requires HTTPS (or localhost) and WebAuthn support.', 'error');
      return;
    }

    pairKeyBtn.disabled = false;
    if (pairedCredentialId) {
      setKeyStatus('A security key is paired for ' + location.hostname + '.', 'ready');
    } else {
      setKeyStatus('Pair a key before encrypting in this mode.', 'ready');
    }
  }

  function requestPrfOutput(credentialId, rpId, prfInput) {
    if (!isWebAuthnAvailable()) {
      var unavailableError = new Error('WebAuthn is unavailable in this context.');
      unavailableError.code = 'WEBAUTHN_UNAVAILABLE';
      return Promise.reject(unavailableError);
    }
    if (rpId !== location.hostname) {
      var originError = new Error('This ciphertext is tied to ' + rpId + ' and must be opened on that site.');
      originError.code = 'RP_MISMATCH';
      return Promise.reject(originError);
    }

    var credentialBytes;
    try {
      credentialBytes = fromBase64Url(credentialId);
      if (!credentialBytes.length || credentialBytes.length > 1023) {
        throw new Error('Invalid security key credential ID.');
      }
    } catch (e) {
      return Promise.reject(e);
    }

    return navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        rpId: rpId,
        allowCredentials: [{ type: 'public-key', id: credentialBytes }],
        timeout: 300000,
        userVerification: 'preferred',
        hints: ['security-key'],
        extensions: { prf: { eval: { first: prfInput } } }
      }
    }).then(function (credential) {
      if (!credential || !credential.rawId || toBase64Url(credential.rawId) !== credentialId) {
        var credentialError = new Error('The security key returned a different credential than requested.');
        credentialError.code = 'CREDENTIAL_MISMATCH';
        throw credentialError;
      }
      var extensions = credential && credential.getClientExtensionResults();
      var result = extensions && extensions.prf && extensions.prf.results && extensions.prf.results.first;
      var resultBytes = result && bytesFrom(result);
      if (!resultBytes || resultBytes.length !== 32) {
        var prfError = new Error('This key or browser did not return a WebAuthn PRF result.');
        prfError.code = 'PRF_RESULT_UNAVAILABLE';
        throw prfError;
      }
      return resultBytes;
    });
  }

  function webAuthnErrorMessage(error, action) {
    if (error && error.code === 'CREDENTIAL_MISMATCH') {
      return 'The security key response did not match the selected credential. Try again or pair the correct key.';
    }
    if (error && error.code === 'PRF_RESULT_UNAVAILABLE') {
      return 'This key or browser did not return a WebAuthn PRF result. Try a compatible FIDO2 security key and browser.';
    }
    if (error && error.code === 'RP_MISMATCH') return error.message;
    if (error && error.code === 'WEBAUTHN_UNAVAILABLE') {
      return 'Security-key mode requires HTTPS (or localhost) and WebAuthn support.';
    }
    if (error && error.name === 'NotAllowedError') {
      return 'The security key request was cancelled or timed out.';
    }
    if (error && error.name === 'SecurityError') {
      return 'WebAuthn security keys can only be used on this site over HTTPS (or localhost).';
    }
    return action + ' failed' + (error && error.message ? ': ' + error.message : '.');
  }

  function pairSecurityKey() {
    if (!isWebAuthnAvailable()) {
      refreshKeyPanel();
      return;
    }

    setLoading(pairKeyBtn, true);
    navigator.credentials.create({
      publicKey: {
        challenge: randomBytes(32),
        rp: { id: location.hostname, name: 'AES Local' },
        user: {
          id: randomBytes(32),
          name: 'local-encryption',
          displayName: 'AES local key'
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 }
        ],
        timeout: 300000,
        authenticatorSelection: {
          authenticatorAttachment: 'cross-platform',
          residentKey: 'discouraged',
          userVerification: 'preferred'
        },
        attestation: 'none',
        hints: ['security-key'],
        extensions: { prf: {} }
      }
    }).then(function (credential) {
      var extensions = credential && credential.getClientExtensionResults();
      if (!extensions || !extensions.prf || extensions.prf.enabled !== true) {
        var prfError = new Error('This key or browser did not confirm WebAuthn PRF support.');
        prfError.code = 'PRF_UNAVAILABLE';
        throw prfError;
      }
      pairedCredentialId = toBase64Url(credential.rawId);
      if (savePairedCredentialId(pairedCredentialId)) {
        setKeyStatus('A security key is paired for ' + location.hostname + '.', 'ready');
      } else {
        setKeyStatus('Key paired for this page session; browser storage is unavailable.', 'error');
      }
    }).catch(function (error) {
      if (error && error.code === 'PRF_UNAVAILABLE') {
        setKeyStatus('This key or browser did not confirm WebAuthn PRF support. Try a compatible FIDO2 key.', 'error');
      } else {
        setKeyStatus(webAuthnErrorMessage(error, 'Pairing'), 'error');
      }
    }).then(function () {
      setLoading(pairKeyBtn, false);
    });
  }

  if (!window.crypto || !window.crypto.subtle) {
    showError('Web Crypto API is not available. Use a modern browser over HTTPS.');
    encBtn.disabled = true;
    decBtn.disabled = true;
    pairKeyBtn.disabled = true;
    return;
  }

  pairedCredentialId = readPairedCredentialId();
  for (var modeIndex = 0; modeIndex < modeInputs.length; modeIndex++) {
    modeInputs[modeIndex].addEventListener('change', function () {
      refreshKeyPanel();
      refreshPasswordLabel();
    });
  }
  inputEl.addEventListener('input', refreshPasswordLabel);
  pairKeyBtn.addEventListener('click', pairSecurityKey);
  refreshKeyPanel();
  refreshPasswordLabel();

  encBtn.addEventListener('click', function () {
    var text = inputEl.value;
    var pass = keyEl.value;
    var encryptionMode = selectedEncryptionMode();
    if (!text) { showError('Enter text to encrypt.'); return; }
    if (!pass && encryptionMode !== 'security-key') {
      showError('Enter a password, or select password + security key.');
      return;
    }
    var encryption;
    if (encryptionMode === 'security-key') {
      if (!isWebAuthnAvailable()) {
        showError('Security-key mode requires HTTPS (or localhost) and WebAuthn support.');
        return;
      }
      if (!pairedCredentialId) {
        showError('Pair a compatible security key before encrypting in this mode.');
        return;
      }
      var credentialId = pairedCredentialId;
      var rpId = location.hostname;
      var prfInput = randomBytes(32);
      setLoading(encBtn, true);
      encryption = requestPrfOutput(credentialId, rpId, prfInput).then(function (prfOutput) {
        return AES.encryptWithHardware(text, pass, keyBits(), {
          rpId: rpId,
          credentialId: credentialId,
          prfInput: prfInput,
          prfOutput: prfOutput
        });
      });
    } else {
      setLoading(encBtn, true);
      encryption = AES.encrypt(text, pass, keyBits());
    }
    encryption.then(function (result) {
      showResult(result);
    }).catch(function (e) {
      showError(webAuthnErrorMessage(e, 'Encryption'));
    }).then(function () {
      setLoading(encBtn, false);
    });
  });

  decBtn.addEventListener('click', function () {
    var text = inputEl.value;
    var pass = keyEl.value;
    if (!text) { showError('Enter ciphertext to decrypt.'); return; }
    if (!pass && !AES.isHardwareCiphertext(text)) {
      showError('Enter the password for password-only ciphertext.');
      return;
    }
    setLoading(decBtn, true);
    AES.decrypt(text, pass, keyBits(), function (metadata) {
      return requestPrfOutput(metadata.credentialId, metadata.rpId, metadata.prfInput);
    }).then(function (result) {
      showResult(result);
    }).catch(function (error) {
      if (error && (error.code === 'CREDENTIAL_MISMATCH' || error.code === 'RP_MISMATCH' ||
          error.code === 'PRF_RESULT_UNAVAILABLE' ||
          error.code === 'WEBAUTHN_UNAVAILABLE' || error.name === 'NotAllowedError' ||
          error.name === 'SecurityError')) {
        showError(webAuthnErrorMessage(error, 'Decryption'));
        return;
      }
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