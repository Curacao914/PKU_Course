export const COURSE_PIPELINE_ADAPTER_METHODS =
  Object.freeze([
    'download',
    'transcribe',
    'buildTextpack',
    'upload',
    'cleanup'
  ])

export function validateCoursePipelineAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw new Error('Course pipeline adapter must be an object')
  }

  for (const method of COURSE_PIPELINE_ADAPTER_METHODS) {
    if (typeof adapter[method] !== 'function') {
      throw new Error(
        `Course pipeline adapter is missing ${method}()`
      )
    }
  }

  return adapter
}

export function createUnconfiguredCoursePipelineAdapter() {
  const fail = step => async () => {
    const error = new Error(
      `Course pipeline adapter step "${step}" is not configured`
    )
    error.code = 'COURSE_PIPELINE_ADAPTER_UNCONFIGURED'
    throw error
  }

  return Object.fromEntries(
    COURSE_PIPELINE_ADAPTER_METHODS.map(method => [
      method,
      fail(method)
    ])
  )
}
