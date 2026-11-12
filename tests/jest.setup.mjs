// Windows shared runners are slower and can transiently hold ports, child
// processes or temp-file handles. Retry failed tests twice; persistent failures
// still fail the suite. POSIX runs are unaffected.
import { jest } from '@jest/globals';

if (process.platform === 'win32') {
  jest.retryTimes(2, { logErrorsBeforeRetry: true });
}
