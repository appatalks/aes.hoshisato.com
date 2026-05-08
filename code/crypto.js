'use strict';

var AES = (function () {
  var PBKDF2_ITERATIONS = 310000;
  var SALT_LEN = 16;
  var IV_LEN = 12;
  var TAG_LEN = 128;

  function toBase64(buf) {
    var bytes = new Uint8Array(buf);
    var binary = '';
    for (var i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function fromBase64(str) {
    var binary = atob(str);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function deriveKey(password, salt, keyLenBits) {
    var enc = new TextEncoder();
    return crypto.subtle.importKey(
      'raw',
      enc.encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    ).then(function (keyMaterial) {
      return crypto.subtle.deriveKey(
        {
          name: 'PBKDF2',
          salt: salt,
          iterations: PBKDF2_ITERATIONS,
          hash: 'SHA-256'
        },
        keyMaterial,
        { name: 'AES-GCM', length: keyLenBits },
        false,
        ['encrypt', 'decrypt']
      );
    });
  }

  function encrypt(plaintext, password, keyLenBits) {
    var salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
    var iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    var enc = new TextEncoder();
    return deriveKey(password, salt, keyLenBits).then(function (key) {
      return crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv, tagLength: TAG_LEN },
        key,
        enc.encode(plaintext)
      );
    }).then(function (cipherBuf) {
      var out = new Uint8Array(SALT_LEN + IV_LEN + cipherBuf.byteLength);
      out.set(salt, 0);
      out.set(iv, SALT_LEN);
      out.set(new Uint8Array(cipherBuf), SALT_LEN + IV_LEN);
      return toBase64(out.buffer);
    });
  }

  function decrypt(ciphertextB64, password, keyLenBits) {
    var raw;
    try {
      raw = fromBase64(ciphertextB64.trim());
    } catch (e) {
      return Promise.reject(new Error('Invalid Base64 input.'));
    }
    if (raw.length < SALT_LEN + IV_LEN + 17) {
      return Promise.reject(new Error('Ciphertext is too short to be valid.'));
    }
    var salt = raw.slice(0, SALT_LEN);
    var iv = raw.slice(SALT_LEN, SALT_LEN + IV_LEN);
    var data = raw.slice(SALT_LEN + IV_LEN);
    return deriveKey(password, salt, keyLenBits).then(function (key) {
      return crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv, tagLength: TAG_LEN },
        key,
        data
      );
    }).then(function (plainBuf) {
      return new TextDecoder().decode(plainBuf);
    });
  }

  return { encrypt: encrypt, decrypt: decrypt };
}());