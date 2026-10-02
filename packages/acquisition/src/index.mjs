export {
  createValidatedAcquisitionRuntime,
  resolveAcquisitionLimits
} from './acquisition-runtime.mjs'

// 教学网连不上时的说法（校园网/VPN 提示）：登录、发现课表这些入口共用
export { PKU_UNREACHABLE_HINT, describePkuFailure, looksLikeNetworkFailure } from './pku-network.mjs'

export {
  DEFAULT_MIN_FREE_BYTES,
  checkFreeSpace,
  formatBytes,
  freeBytes
} from './disk.mjs'

export {
  acquireProfileLock,
  clearStaleProfileLock,
  entryExists,
  isProcessAlive,
  parseSingletonLock
} from './profile-lock.mjs'

export {
  REPLAY_IDENTITY_VERSION,
  assertNoSecrets,
  chooseCurrentCourses,
  compareWithState,
  courseKey,
  dedupeRecordings,
  normalizeCourseName,
  normalizeRecordingRow,
  parseCourseLabel,
  replayKey,
  semanticReplayIdentity
} from './platform-core.mjs'

export {
  assertNoInputValues,
  chooseLoginControls,
  describeUrl,
  passwordScore,
  sanitizeControl,
  templatePath,
  usernameScore
} from './login-core.mjs'

export {
  assertStateHasNoSecrets,
  buildSafeState,
  chooseAudioRendition,
  chooseVariant,
  extensionForUrl,
  fileComplete,
  parseAttributeList,
  parseMasterPlaylist,
  parseMediaPlaylist,
  redactText,
  renderLocalPlaylist,
  safeName,
  selectSampleResources,
  writeJsonAtomic
} from './hls-core.mjs'
