export {
  createValidatedAcquisitionRuntime,
  resolveAcquisitionLimits
} from './acquisition-runtime.mjs'

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
