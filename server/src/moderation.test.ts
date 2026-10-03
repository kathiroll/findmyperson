import { describe, expect, test } from 'vitest';
import { moderateResponse } from './moderation';

describe('moderateResponse', () => {
  test.each([
    'I saw him near the bus stop around 6pm, wearing a blue jacket.',
    'Looked like he was heading toward the station. He seemed fine.',
    'Call me, I know the family. Number shared below.',
  ])('delivers ordinary text: %s', (text) => {
    expect(moderateResponse(text)).toEqual({ held: false });
  });

  test.each([
    ['check https://example.com/photo', 'url'],
    ['see www.evil.xyz now', 'url'],
    ['go to evil dot com', 'url'],
    ['evil[.]com has the details', 'url'],
    ['bit.ly/3abc', 'url'],
    ['pay at 0x52908400098527886E0F7030069857D2E4169EE7', 'crypto_address'],
    ['btc 1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 'crypto_address'],
    ['bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'crypto_address'],
    ['reward to TQrY8tryqsYVCYS3MFbtffiPp2ccyn169P', 'crypto_address'],
    ['send it to rahul.k@okaxis', 'upi_id'],
    ['Please send me money and I will tell you more', 'payment_phrase'],
    ['I want a gift card first', 'payment_phrase'],
    ['pay via PayTM', 'payment_phrase'],
    ['ｈｔｔｐｓ：／／example.com', 'url'],
  ])('holds %s', (text, reason) => {
    expect(moderateResponse(text)).toEqual({ held: true, reason });
  });
});
