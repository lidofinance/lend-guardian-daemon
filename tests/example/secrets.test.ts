import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { padHex } from 'viem';
import { MASK, Secrets } from '../../example/secrets.ts';

/** Write a file for this test only and return its path. */
function withFile(context: TestContext, text: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'guardian-secrets-'));
  context.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const path = join(directory, 'secret');
  writeFileSync(path, text);
  return path;
}

/** One secret of the name, set directly. */
function secret(name: string, value: string): Secrets {
  return Secrets.read([name], { [name]: value });
}

// ── Reading ──

test('a secret comes from its variable or, trimmed, from its file, and a name not asked for is not read', (context) => {
  const secrets = Secrets.read(['TEST_KEY', 'TEST_URL', 'TEST_UNSET'], {
    TEST_KEY: 'plain-key',
    TEST_URL_FILE: withFile(context, ' https://screening.example/key \n'),
    TEST_OTHER: 'other-key',
  });

  assert.equal(secrets.value('TEST_KEY'), 'plain-key');
  assert.equal(secrets.value('TEST_URL'), 'https://screening.example/key');
  assert.equal(secrets.value('TEST_UNSET'), undefined);
  assert.equal(secrets.value('TEST_OTHER'), undefined);
  assert.equal(secrets.required('TEST_KEY'), 'plain-key');
  assert.throws(() => secrets.required('TEST_UNSET'), { message: 'TEST_UNSET is not set' });
});

test('a secret set both in its variable and in its file is refused, and the error names only the variables', (context) => {
  const variables = { TEST_URL: 'https://screening.example/a', TEST_URL_FILE: withFile(context, 'secret-token') };
  assert.throws(
    () => Secrets.read(['TEST_URL'], variables),
    (thrown: unknown) => {
      assert.ok(thrown instanceof Error);
      assert.equal(thrown.message, 'TEST_URL and TEST_URL_FILE are both set');
      assert.doesNotMatch(thrown.message, /screening\.example|secret-token/);
      return true;
    },
  );
});

test('a secret file that cannot be read is refused by its variable name', (context) => {
  const missing = join(withFile(context, ''), 'missing');
  assert.throws(() => Secrets.read(['TEST_URL'], { TEST_URL_FILE: missing }), {
    message: 'TEST_URL_FILE cannot be read',
  });
});

// ── Formats ──

test('a secret key is a 32-byte hex secp256k1 key, and an error names the secret, never the key', () => {
  const key = padHex('0x02', { size: 32 });
  assert.equal(secret('TEST_KEY', key).privateKey('TEST_KEY'), key);
  assert.throws(() => secret('TEST_KEY', '0x02').privateKey('TEST_KEY'), {
    message: 'TEST_KEY is not a 32-byte hex value',
  });
  assert.throws(() => secret('TEST_KEY', padHex('0x00', { size: 32 })).privateKey('TEST_KEY'), {
    message: 'TEST_KEY is not a valid secp256k1 key',
  });
});

test('a URL list is comma-separated HTTP or HTTPS URLs, each trimmed', () => {
  const secrets = secret('TEST_URLS', 'https://rpc.example/v3/key-1, http://rpc.example/key-2');
  assert.deepEqual(secrets.urlList('TEST_URLS'), ['https://rpc.example/v3/key-1', 'http://rpc.example/key-2']);
  assert.throws(() => secret('TEST_URLS', 'https://rpc.example/a,').urlList('TEST_URLS'), {
    message: 'TEST_URLS contains an empty URL',
  });
  assert.throws(() => secret('TEST_URLS', 'ftp://rpc.example/a').urlList('TEST_URLS'), {
    message: 'TEST_URLS must contain HTTP or HTTPS URLs',
  });
});

// ── Masking ──

test('mask replaces a secret value, and each URL of a URL list in the form given and as parsed', () => {
  const key = '0x0000000000000000000000000000000000000000000000000000000000000002';
  const secrets = Secrets.read(['SIGNER_KEY', 'RPC_URLS'], {
    SIGNER_KEY: key,
    RPC_URLS: 'https://rpc-a.example/v3/0123456789abcdef0123, https://rpc-b.example',
  });

  assert.equal(secrets.mask(`key ${key}`), `key ${MASK}`);
  assert.equal(secrets.mask('URL: https://rpc-a.example/v3/0123456789abcdef0123'), `URL: ${MASK}`);
  assert.equal(secrets.mask('failover to https://rpc-b.example'), `failover to ${MASK}`);
  assert.equal(secrets.mask('failover to https://rpc-b.example/'), `failover to ${MASK}`);
});

test('mask replaces a URL without its userinfo, as the transport prints it, and its long password', () => {
  const secrets = secret('RPC_URLS', 'https://guardian:Pa55word-0123456789@rpc.example/v2/abcdefghijklmnop1234');

  assert.equal(secrets.mask('URL: https://rpc.example/v2/abcdefghijklmnop1234'), `URL: ${MASK}`);
  assert.equal(secrets.mask('wrong password Pa55word-0123456789'), `wrong password ${MASK}`);
});

test('mask replaces long path segments and query values alone', () => {
  const secrets = secret(
    'RPC_URLS',
    'https://rpc.example/v3/0123456789abcdef0123?apiKey=Ab12Cd34Ef56Gh78Ij90&chain=mainnet',
  );

  assert.equal(secrets.mask('unknown key 0123456789abcdef0123'), `unknown key ${MASK}`);
  assert.equal(secrets.mask('apiKey=Ab12Cd34Ef56Gh78Ij90 refused'), `apiKey=${MASK} refused`);
});

test('mask keeps the short parts of a URL, so names in records stay readable', () => {
  const secrets = Secrets.read(['RPC_URLS', 'SCREENING_URL'], {
    RPC_URLS: 'https://eth.rpc.example/v3/0123456789abcdef0123?chain=mainnet',
    SCREENING_URL: 'http://screening.invalid/screening',
  });

  const text = 'rpc.requestFinished eth_getLogs v3 mainnet screening.requestFinished';
  assert.equal(secrets.mask(text), text);
});

test('a comma that does not separate URLs splits nothing, so its parts are not masked alone', () => {
  const url = 'http://screening.invalid/v1/screening,requestFinished';
  const secrets = secret('SCREENING_URL', url);

  assert.equal(secrets.mask('screening.requestFinished'), 'screening.requestFinished');
  assert.equal(secrets.mask(`post ${url}`), `post ${MASK}`);
});

test('mask keeps a value under five characters and a transformed form, and replaces a longer secret first', () => {
  const key = 'key/with+special=chars';
  const secrets = Secrets.read(['SHORT', 'API_KEY', 'LONGER_KEY'], {
    SHORT: 'abcd',
    API_KEY: key,
    LONGER_KEY: `${key}-and-more`,
  });

  assert.equal(secrets.mask('abcd'), 'abcd');
  // The known limit: a form that a program computes from a value, for example Base64, is not masked.
  const base64 = Buffer.from(key).toString('base64');
  assert.equal(secrets.mask(base64), base64);
  assert.equal(secrets.mask(`${key}-and-more`), MASK);
});
