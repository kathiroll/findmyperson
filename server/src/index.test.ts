import { expect, test } from 'vitest';
import { packageName } from './index';

test('workspace member is wired into the test runner', () => {
  expect(packageName).toBe('@findmyperson/server');
});
