module.exports = {
  root: true,
  extends: '@react-native',
  overrides: [
    {
      files: ['src/domain/**/*.{ts,tsx}'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: [
                  'react',
                  'react-native',
                  'react-native/*',
                  'expo',
                  'expo-*',
                  'node:*',
                  'fs',
                  'path',
                  '../infrastructure/*',
                  '../ui/*',
                  '../features/*',
                  '../app/*',
                  '../../modules/context-native/*',
                ],
                message:
                  'The domain layer must remain independent of UI, repositories, file APIs, and native modules.',
              },
            ],
          },
        ],
      },
    },
  ],
};
