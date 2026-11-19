/**
 * Idarah - SHA-256 Cryptographic Hash Chain Engine
 * hash-chain.js
 * 
 * Plain-English Purpose:
 * Provides a self-contained, offline SHA-256 cryptographic hashing implementation
 * and blockchain-style verification routines for Idarah's financial ledger.
 * Every financial entry links to the previous entry via prevHash, ensuring that
 * any alteration, tampering, or deletion immediately breaks the cryptographic chain.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.IDARAH_HASH = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Pure JavaScript implementation of standard FIPS 180-4 SHA-256.
   * Runs natively in any browser or webview without network calls or external libraries.
   */
  function sha256(ascii) {
    // Encode to UTF-8 bytes first so Urdu/Hindi/Bengali text hashes correctly.
    // Pure ASCII input is unchanged, so existing ASCII-only ledger hashes stay valid.
    ascii = unescape(encodeURIComponent(String(ascii)));

    function rightRotate(value, amount) {
      return (value >>> amount) | (value << (32 - amount));
    }

    const mathPow = Math.pow;
    const maxWord = mathPow(2, 32);
    let lengthProperty = 'length';
    let i, j;
    let result = '';

    const words = [];
    const asciiBitLength = ascii[lengthProperty] * 8;

    let hash = [];
    const k = [];
    let primeCounter = 0;

    const isComposite = {};
    for (let candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (i = 0; i < 313; i += candidate) {
          isComposite[i] = candidate;
        }
        hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
        k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
      }
    }

    hash = hash.slice(0, 8);

    ascii += '\x80';
    while ((ascii[lengthProperty] % 64) - 56) ascii += '\x00';
    for (i = 0; i < ascii[lengthProperty]; i++) {
      j = ascii.charCodeAt(i);
      words[i >> 2] |= j << (((3 - i) % 4) * 8);
    }
    words[words[lengthProperty]] = (asciiBitLength / maxWord) | 0;
    words[words[lengthProperty]] = asciiBitLength | 0;

    for (j = 0; j < words[lengthProperty]; ) {
      const w = words.slice(j, (j += 16));
      const oldHash = hash;
      hash = hash.slice(0, 8);

      for (i = 0; i < 64; i++) {
        const i2 = i + j;
        const w15 = w[i - 15],
          w2 = w[i - 2];

        const s0 = rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3);
        const s1 = rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10);
        w[i] =
          i < 16
            ? w[i]
            : (w[i - 16] + s0 + w[i - 7] + s1) | 0;

        const s1b =
          rightRotate(hash[4], 6) ^ rightRotate(hash[4], 11) ^ rightRotate(hash[4], 25);
        const ch = (hash[4] & hash[5]) ^ (~hash[4] & hash[6]);
        const temp1 = (hash[7] + s1b + ch + k[i] + w[i]) | 0;
        const s0b =
          rightRotate(hash[0], 2) ^ rightRotate(hash[0], 13) ^ rightRotate(hash[0], 22);
        const maj = (hash[0] & hash[1]) ^ (hash[0] & hash[2]) ^ (hash[1] & hash[2]);
        const temp2 = (s0b + maj) | 0;

        hash = [(temp1 + temp2) | 0].concat(hash);
        hash[4] = (hash[4] + temp1) | 0;
        hash.pop();
      }

      for (i = 0; i < 8; i++) {
        hash[i] = (hash[i] + oldHash[i]) | 0;
      }
    }

    for (i = 0; i < 8; i++) {
      for (let b = 3; b >= 0; b--) {
        const byte = (hash[i] >> (8 * b)) & 255;
        result += (byte < 16 ? '0' : '') + byte.toString(16);
      }
    }
    return result;
  }

  /**
   * Normalizes a field into a stable string representation for cryptographic hashing.
   */
  function normalizeField(val) {
    if (val === null || val === undefined) return '';
    return String(val).trim();
  }

  /**
   * Computes the SHA-256 hash digest for an entry by strictly concatenating
   * all 17 specified ledger fields with standard pipe delimiter '|'.
   * 
   * The 17 fields in exact sequence:
   * 1.  seq           (Integer block sequence number)
   * 2.  date          (India Standard Time formatted date string)
   * 3.  type          (donation | expense | reversal)
   * 4.  amount        (Normalized decimal/integer amount)
   * 5.  fundId        (Target fund identifier)
   * 6.  method        (Payment method: Cash, UPI, Bank, Cheque)
   * 7.  category      (Expense category or donation description)
   * 8.  note          (Optional note/memo)
   * 9.  donorName     (Donor name, or empty/Anonymous)
   * 10. donorPhone    (Donor phone, or empty)
   * 11. receiptNo     (e.g. RCP-0001, or empty for expenses)
   * 12. verifyCode    (8-character receipt verification code)
   * 13. billPhoto     (Short SHA-256 hash or data signature of the attached bill)
   * 14. recordedBy    (Full name / role of staff member logging entry)
   * 15. reversesSeq   (Sequence number of entry being reversed, or empty)
   * 16. reversesType  (Type of entry being reversed, or empty)
   * 17. prevHash      (SHA-256 hash of previous block, or 'GENESIS' for block 1)
   */
  function computeEntryHash(entry, prevHash) {
    const pHash = normalizeField(prevHash || entry.prevHash || 'GENESIS');

    // For attached bill images, hash the base64 data to keep ledger payload compact
    let billPhotoHash = '';
    if (entry.billPhoto && typeof entry.billPhoto === 'string') {
      billPhotoHash = entry.billPhoto.startsWith('data:')
        ? sha256(entry.billPhoto.substring(0, 1024))
        : entry.billPhoto;
    }

    const fields = [
      normalizeField(entry.seq),
      normalizeField(entry.date),
      normalizeField(entry.type),
      normalizeField(entry.amount),
      normalizeField(entry.fundId),
      normalizeField(entry.method),
      normalizeField(entry.category),
      normalizeField(entry.note),
      normalizeField(entry.donorName),
      normalizeField(entry.donorPhone),
      normalizeField(entry.receiptNo),
      normalizeField(entry.verifyCode),
      normalizeField(billPhotoHash),
      normalizeField(entry.recordedBy),
      normalizeField(entry.reversesSeq),
      normalizeField(entry.reversesType),
      pHash
    ];

    const payload = fields.join('|');
    return sha256(payload);
  }

  /**
   * Verifies the cryptographic integrity of the entire ledger chain.
   * Traverses all entries in order, recalculating each block's SHA-256 hash
   * from the 17 fields and ensuring prevHash matches the preceding block's hash.
   * 
   * Returns:
   *   { valid: true, count: number } if completely intact
   *   { valid: false, brokenSeq: number, reason: string } if tampering is detected
   */
  function verifyChainIntegrity(ledgerEntries) {
    if (!Array.isArray(ledgerEntries) || ledgerEntries.length === 0) {
      return { valid: true, count: 0, message: 'Ledger is empty' };
    }

    let expectedPrevHash = 'GENESIS';

    for (let i = 0; i < ledgerEntries.length; i++) {
      const entry = ledgerEntries[i];
      const entrySeq = Number(entry.seq);

      // Verify sequence continuity
      if (entrySeq !== i + 1) {
        return {
          valid: false,
          brokenSeq: entrySeq,
          reason: `Broken sequence order: Expected block #${i + 1} but found #${entrySeq}`
        };
      }

      // Verify prevHash linkage
      if (entry.prevHash !== expectedPrevHash) {
        return {
          valid: false,
          brokenSeq: entrySeq,
          reason: `PrevHash mismatch in block #${entrySeq}. Link to preceding block is severed.`
        };
      }

      // Recompute SHA-256 hash from all 17 fields
      const computedHash = computeEntryHash(entry, expectedPrevHash);
      if (computedHash !== entry.hash) {
        return {
          valid: false,
          brokenSeq: entrySeq,
          reason: `Digest mismatch in block #${entrySeq}. Stored hash does not match computed 17-field hash.`
        };
      }

      expectedPrevHash = entry.hash;
    }

    return {
      valid: true,
      count: ledgerEntries.length,
      lastHash: expectedPrevHash
    };
  }

  return {
    sha256: sha256,
    computeEntryHash: computeEntryHash,
    verifyChainIntegrity: verifyChainIntegrity
  };
});
