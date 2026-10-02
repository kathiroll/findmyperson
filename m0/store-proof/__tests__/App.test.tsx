import { act, create } from 'react-test-renderer';
import App from '../App';

// The Turbo module and op-sqlite are native; Jest only checks that the screen renders and shows the pinned values.
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('../src/specs/NativeStoreProof', () => ({
  __esModule: true,
  default: {},
}));
jest.mock('@op-engineering/op-sqlite', () => ({
  open: jest.fn(),
  isSQLCipher: jest.fn(),
}));

test('renders the pinned cipher parameters', async () => {
  let tree!: ReturnType<typeof create>;
  await act(() => {
    tree = create(<App />);
  });
  const text = JSON.stringify(tree.toJSON());
  expect(text).toContain('256000');
  expect(text).toContain('Read in TypeScript');
});
