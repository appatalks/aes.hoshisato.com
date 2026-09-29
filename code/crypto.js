'use strict';

var AES = (function () {
  var PBKDF2_ITERATIONS = 310000;
  var SALT_LEN = 16;
  var IV_LEN = 12;
  var TAG_LEN = 128;
  var PRF_INPUT_LEN = 32;
  var PRF_OUTPUT_LEN = 32;
  var HARDWARE_PREFIX = 'AES-HW1:';

  function toBytes(value) {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    throw new Error('Invalid binary value.');
  }

  function toBase64(buf) {
    var bytes = toBytes(buf);
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

  function toBase64Url(buf) {
    return toBase64(buf).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  }

  function fromBase64Url(str) {
    if (typeof str !== 'string' || !str || !/^[A-Za-z0-9_-]+$/.test(str)) {
      throw new Error('Invalid Base64URL value.');
    }
    var base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    return fromBase64(base64);
  }

  function deriveKey(password, salt, keyLenBits, prfOutput) {
    var enc = new TextEncoder();
    var passwordBytes = enc.encode(password);
    var keyMaterialBytes = passwordBytes;
    if (prfOutput) {
      var prfBytes = toBytes(prfOutput);
      if (prfBytes.length !== PRF_OUTPUT_LEN) {
        throw new Error('Security key returned an invalid PRF result.');
      }
      var contextBytes = enc.encode('AES-HW1-PBKDF2\u0000');
      keyMaterialBytes = new Uint8Array(contextBytes.length + 4 + passwordBytes.length + prfBytes.length);
      keyMaterialBytes.set(contextBytes, 0);
      var passwordLengthOffset = contextBytes.length;
      new DataView(keyMaterialBytes.buffer).setUint32(passwordLengthOffset, passwordBytes.length, false);
      keyMaterialBytes.set(passwordBytes, passwordLengthOffset + 4);
      keyMaterialBytes.set(prfBytes, passwordLengthOffset + 4 + passwordBytes.length);
    }
    return crypto.subtle.importKey(
      'raw',
      keyMaterialBytes,
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

  function encryptWithHardware(plaintext, password, keyLenBits, hardware) {
    var credentialBytes;
    var prfInput;
    var prfOutput;
    try {
      if (!hardware || typeof hardware.rpId !== 'string' || !hardware.rpId) {
        throw new Error('Security key details are missing.');
      }
      credentialBytes = fromBase64Url(hardware.credentialId);
      prfInput = toBytes(hardware.prfInput);
      prfOutput = toBytes(hardware.prfOutput);
      if (!credentialBytes.length || credentialBytes.length > 1023) {
        throw new Error('Invalid security key credential ID.');
      }
      if (prfInput.length !== PRF_INPUT_LEN || prfOutput.length !== PRF_OUTPUT_LEN) {
        throw new Error('Security key returned invalid PRF data.');
      }
    } catch (e) {
      return Promise.reject(e);
    }

    var salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
    var iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    var enc = new TextEncoder();
    return deriveKey(password, salt, keyLenBits, prfOutput).then(function (key) {
      return crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv, tagLength: TAG_LEN },
        key,
        enc.encode(plaintext)
      );
    }).then(function (cipherBuf) {
      var envelope = {
        version: 1,
        mode: 'webauthn-prf',
        keyBits: keyLenBits,
        rpId: hardware.rpId,
        credentialId: hardware.credentialId,
        prfInput: toBase64Url(prfInput),
        salt: toBase64Url(salt),
        iv: toBase64Url(iv),
        data: toBase64Url(cipherBuf)
      };
      return HARDWARE_PREFIX + toBase64(enc.encode(JSON.stringify(envelope)));
    });
  }

  function parseHardwareEnvelope(ciphertext) {
    var rawEnvelope = fromBase64(ciphertext.slice(HARDWARE_PREFIX.length).trim());
    var envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawEnvelope));
    if (!envelope || envelope.version !== 1 || envelope.mode !== 'webauthn-prf' ||
        (envelope.keyBits !== 128 && envelope.keyBits !== 256) ||
        typeof envelope.rpId !== 'string' || !envelope.rpId ||
        typeof envelope.credentialId !== 'string') {
      throw new Error('Invalid security-key ciphertext.');
    }

    var credentialBytes = fromBase64Url(envelope.credentialId);
    var prfInput = fromBase64Url(envelope.prfInput);
    var salt = fromBase64Url(envelope.salt);
    var iv = fromBase64Url(envelope.iv);
    var data = fromBase64Url(envelope.data);
    if (!credentialBytes.length || credentialBytes.length > 1023 ||
        prfInput.length !== PRF_INPUT_LEN || salt.length !== SALT_LEN ||
        iv.length !== IV_LEN || data.length < 17) {
      throw new Error('Invalid security-key ciphertext.');
    }

    return {
      metadata: {
        rpId: envelope.rpId,
        credentialId: envelope.credentialId,
        prfInput: prfInput
      },
      keyBits: envelope.keyBits,
      salt: salt,
      iv: iv,
      data: data
    };
  }

  function decryptHardware(ciphertext, password, hardwareKeyResolver) {
    var envelope;
    try {
      envelope = parseHardwareEnvelope(ciphertext);
    } catch (e) {
      return Promise.reject(new Error('Invalid security-key ciphertext.'));
    }
    if (typeof hardwareKeyResolver !== 'function') {
      return Promise.reject(new Error('This ciphertext requires its security key.'));
    }

    return Promise.resolve().then(function () {
      return hardwareKeyResolver(envelope.metadata);
    }).then(function (prfOutput) {
      return deriveKey(password, envelope.salt, envelope.keyBits, prfOutput);
    }).then(function (key) {
      return crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: envelope.iv, tagLength: TAG_LEN },
        key,
        envelope.data
      );
    }).then(function (plainBuf) {
      return new TextDecoder().decode(plainBuf);
    });
  }

  function decryptLegacy(ciphertextB64, password, keyLenBits) {
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

  function decrypt(ciphertext, password, keyLenBits, hardwareKeyResolver) {
    if (typeof ciphertext !== 'string') {
      return Promise.reject(new Error('Invalid ciphertext input.'));
    }
    if (isHardwareCiphertext(ciphertext)) {
      return decryptHardware(ciphertext.trim(), password, hardwareKeyResolver);
    }
    return decryptLegacy(ciphertext, password, keyLenBits);
  }

  function isHardwareCiphertext(ciphertext) {
    return typeof ciphertext === 'string' && ciphertext.trim().indexOf(HARDWARE_PREFIX) === 0;
  }

  return {
    encrypt: encrypt,
    encryptWithHardware: encryptWithHardware,
    decrypt: decrypt,
    isHardwareCiphertext: isHardwareCiphertext
  };
}());