import { createClient } from '@supabase/supabase-js'
import { decryptFields, decryptSecret, encryptFields, encryptSecret } from './crypto.mjs'

const PROVIDERS = new Set(['ocr', 'deepseek', 'dashscope'])

export function createAccountStore(env = process.env) {
  const url = env.SUPABASE_URL
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Course control 缺少 Supabase 服务端凭据')
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const encryptionKey = env.COURSE_ACCOUNT_ENCRYPTION_KEY

  async function profile(ownerId) {
    const { data, error } = await supabase.from('profiles')
      .select('id, role, status, email, notification_email').eq('id', ownerId).single()
    if (error) throw error
    if (data.status !== 'active') throw new Error('账户尚未启用')
    return data
  }

  async function setNotificationEmail(ownerId, email) {
    const value = String(email || '').trim().toLowerCase()
    if (value && (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) {
      throw Object.assign(new Error('通知邮箱格式不正确'), { status: 400 })
    }
    const { data, error } = await supabase.from('profiles')
      .update({ notification_email: value || null, updated_at: new Date().toISOString() })
      .eq('id', ownerId).select('id,email,notification_email').single()
    if (error) throw error
    return data
  }

  async function credentialRows(ownerId) {
    const { data, error } = await supabase.from('provider_credentials')
      .select('provider, ciphertext, iv, auth_tag, last4, verified_at, updated_at').eq('owner_id', ownerId)
    if (error) throw error
    return data || []
  }

  async function credentials(ownerId) {
    const rows = await credentialRows(ownerId)
    return Object.fromEntries(rows.map(row => [row.provider, decryptSecret(row, encryptionKey, `${ownerId}:provider:${row.provider}`)]))
  }

  async function credentialStatus(ownerId) {
    const rows = await credentialRows(ownerId)
    return Object.fromEntries(rows.map(row => [row.provider, {
      configured: true, last4: row.last4 || '', verifiedAt: row.verified_at, updatedAt: row.updated_at
    }]))
  }

  async function putCredential(ownerId, provider, secret) {
    if (!PROVIDERS.has(provider)) throw new Error('未知凭据类型')
    const value = String(secret || '').trim()
    if (!value) throw new Error('凭据不能为空')
    const encrypted = encryptSecret(value, encryptionKey, `${ownerId}:provider:${provider}`)
    const { error } = await supabase.from('provider_credentials').upsert({
      owner_id: ownerId,
      provider,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      auth_tag: encrypted.authTag,
      last4: value.slice(-4),
      verified_at: null,
      updated_at: new Date().toISOString()
    }, { onConflict: 'owner_id,provider' })
    if (error) throw error
    return { provider, configured: true, last4: value.slice(-4) }
  }

  async function deleteCredential(ownerId, provider) {
    if (!PROVIDERS.has(provider)) throw new Error('未知凭据类型')
    const { error } = await supabase.from('provider_credentials')
      .delete().eq('owner_id', ownerId).eq('provider', provider)
    if (error) throw error
  }

  async function getPkuConnection(ownerId) {
    const { data, error } = await supabase.from('pku_connections').select('*').eq('owner_id', ownerId).maybeSingle()
    if (error) throw error
    return data
  }

  async function pkuSecrets(ownerId) {
    const row = await getPkuConnection(ownerId)
    return {
      row,
      username: decryptFields('username', row, encryptionKey, ownerId),
      password: decryptFields('password', row, encryptionKey, ownerId),
      session: decryptFields('session', row, encryptionKey, ownerId)
    }
  }

  async function putPkuPassword(ownerId, username, password) {
    const user = String(username || '').trim()
    const pass = String(password || '')
    if (!user || !pass) throw new Error('教学网账号和密码不能为空')
    const { error } = await supabase.from('pku_connections').upsert({
      owner_id: ownerId,
      mode: 'password',
      ...encryptFields('username', user, encryptionKey, ownerId),
      ...encryptFields('password', pass, encryptionKey, ownerId),
      status: 'needs_reauth',
      updated_at: new Date().toISOString()
    }, { onConflict: 'owner_id' })
    if (error) throw error
  }

  async function savePkuSession(ownerId, session, { mode, status = 'connected', errorText = '' } = {}) {
    const patch = {
      owner_id: ownerId,
      ...encryptFields('session', String(session || ''), encryptionKey, ownerId),
      status,
      last_error: errorText,
      last_verified_at: status === 'connected' ? new Date().toISOString() : null,
      updated_at: new Date().toISOString()
    }
    if (mode) patch.mode = mode
    const { error } = await supabase.from('pku_connections').upsert(patch, { onConflict: 'owner_id' })
    if (error) throw error
  }

  async function markPku(ownerId, patch) {
    const { error } = await supabase.from('pku_connections').upsert({
      owner_id: ownerId, ...patch, updated_at: new Date().toISOString()
    }, { onConflict: 'owner_id' })
    if (error) throw error
  }

  async function deletePkuPassword(ownerId) {
    const { error } = await supabase.from('pku_connections').update({
      username_ciphertext: null, username_iv: null, username_tag: null,
      password_ciphertext: null, password_iv: null, password_tag: null,
      mode: 'qr', auto_sync_enabled: false, updated_at: new Date().toISOString()
    }).eq('owner_id', ownerId)
    if (error) throw error
  }

  async function setPkuSelection(ownerId, { selectedCourseKeys = [], autoSyncEnabled = false }) {
    const current = await getPkuConnection(ownerId)
    const selected = validateCourseSelection(selectedCourseKeys, current?.scanned_course_keys || [])
    await markPku(ownerId, {
      selected_course_keys: selected,
      auto_sync_enabled: Boolean(autoSyncEnabled && current?.password_ciphertext)
    })
  }

  async function saveScannedCourses(ownerId, keys, {replace = true} = {}) {
    const current = await getPkuConnection(ownerId)
    const scanned = [...new Set([...(replace ? [] : current?.scanned_course_keys || []), ...keys])]
    await markPku(ownerId, { scanned_course_keys: scanned,
      selected_course_keys: (current?.selected_course_keys || []).filter(key => scanned.includes(key)) })
  }

  async function resourceLimits(ownerId) {
    const user = await profile(ownerId)
    const { data, error } = await supabase.from('user_resource_limits').select('owner_id,storage_quota_bytes,max_file_bytes').eq('owner_id', ownerId).maybeSingle()
    if (error) throw error
    if (data) return data
    const defaults = user.role === 'owner'
      ? { storage_quota_bytes: 1099511627776, max_file_bytes: 2147483648 }
      : { storage_quota_bytes: 1073741824, max_file_bytes: 268435456 }
    const { data: created, error: createError } = await supabase.from('user_resource_limits')
      .upsert({ owner_id: ownerId, ...defaults }, { onConflict: 'owner_id' }).select('owner_id,storage_quota_bytes,max_file_bytes').single()
    if (createError) throw createError
    return created
  }




  async function notifyEmail(ownerId, { eventKey, title, summary = '', link = 'https://law-tech.dev/desk/courses' }) {
    const key = String(eventKey || '')
    if (key) {
      const { data: existing, error: readError } = await supabase.from('reminders')
        .select('id').eq('owner_id', ownerId).eq('status', 'pending')
        .contains('payload', { eventKey: key }).limit(1)
      if (readError) throw readError
      if (existing?.length) return { queued: false, existing: existing[0].id }
    }
    const { data, error } = await supabase.from('reminders').insert({
      owner_id: ownerId,
      channel: 'email',
      remind_at: new Date().toISOString(),
      status: 'pending',
      payload: {
        eventKey: key,
        title: String(title || '课程提醒'),
        summary: String(summary || ''),
        links: link ? [{ title: '打开课程工作台', url: link }] : []
      }
    }).select('id').single()
    if (error) throw error
    return { queued: true, id: data.id }
  }

  async function autoSyncOwners() {
    const { data, error } = await supabase.from('pku_connections')
      .select('owner_id').eq('auto_sync_enabled', true)
    if (error) throw error
    return (data || []).map(item => item.owner_id)
  }

  async function savePrivateNote(ownerId, input) {
    const replayKey = String(input.replayKey || '')
    const metadata = {
      replayKey,
      courseName: String(input.courseName || ''),
      lessonTitle: String(input.lessonTitle || ''),
      slug: String(input.slug || ''),
      checksum: String(input.checksum || ''),
      lessonDate: String(input.lessonDate || ''),
      index: input.index && typeof input.index === 'object' ? input.index : null,
      source: 'course-worker',
      updatedFromCourseAt: new Date().toISOString()
    }
    // replayKey 历史上并非全局唯一：真实课程数据里出现过两节课共用 replayKey。
    // 私有空间优先用发布层已经去冲突的 slug 定位；只有老记录没有 slug 时，才允许
    // “唯一 replayKey”兜底。这样同课次标题/日期相近也不会互相覆盖。
    const { data: candidates, error: readError } = await supabase.from('notes')
      .select('id, metadata').eq('owner_id', ownerId).eq('note_type', 'course')
    if (readError) throw readError
    const slug = String(input.slug || '')
    const bySlug = slug ? (candidates || []).find(row => String(row.metadata?.slug || '') === slug) : null
    const byReplay = (candidates || []).filter(row => String(row.metadata?.replayKey || '') === replayKey)
    const existing = bySlug || (byReplay.length === 1 ? byReplay[0] : null)
    if (existing) {
      const { data, error } = await supabase.from('notes').update({
        title: String(input.lessonTitle || input.courseName || '课程笔记'),
        body_markdown: String(input.markdown || ''),
        status: 'published',
        metadata,
        updated_at: new Date().toISOString()
      }).eq('id', existing.id).eq('owner_id', ownerId).select('*').single()
      if (error) throw error
      if (!input.silent) {
        await notifyEmail(ownerId, {
          eventKey: 'course-note:' + replayKey + ':' + data.updated_at,
          title: '课程笔记已完成：' + String(input.courseName || '') + ' · ' + String(input.lessonTitle || ''),
          summary: '新的课程笔记已经保存到你的个人工作台。'
        })
      }
      return data
    }
    const { data, error } = await supabase.from('notes').insert({
      owner_id: ownerId,
      title: String(input.lessonTitle || input.courseName || '课程笔记'),
      body_markdown: String(input.markdown || ''),
      note_type: 'course',
      status: 'published',
      metadata
    }).select('*').single()
    if (error) throw error
    if (!input.silent) {
      await notifyEmail(ownerId, {
        eventKey: 'course-note:' + replayKey + ':' + data.updated_at,
        title: '课程笔记已完成：' + String(input.courseName || '') + ' · ' + String(input.lessonTitle || ''),
        summary: '新的课程笔记已经保存到你的个人工作台。'
      })
    }
    return data
  }


  async function privateNotes(ownerId) {
    const { data, error } = await supabase.from('notes')
      .select('id,title,body_markdown,note_type,status,metadata,created_at,updated_at')
      .eq('owner_id', ownerId).in('note_type', ['course', 'course-topic'])
      .order('updated_at', { ascending: false })
    if (error) throw error
    return data || []
  }

  function privateTopicStatus(topic, noteBySlug) {
    const artifact = topic?.metadata?.artifact
    if (!artifact || !Array.isArray(artifact.lessons)) return 'missing'
    for (const lesson of artifact.lessons) {
      const note = noteBySlug.get(String(lesson?.slug || ''))
      if (!note) return 'stale'
      const current = String(note.metadata?.checksum || '')
      const built = String(lesson?.checksum || '')
      if (built && current !== built) return 'stale'
    }
    return 'fresh'
  }

  async function privateContent(ownerId) {
    const rows = await privateNotes(ownerId)
    const notes = rows.filter(row => row.note_type === 'course')
    const noteBySlug = new Map(notes.map(row => [String(row.metadata?.slug || ''), row]).filter(([slug]) => slug))
    const topics = rows.filter(row => row.note_type === 'course-topic').map(row => ({
      id: row.id,
      topicId: String(row.metadata?.topicId || ''),
      courseName: String(row.metadata?.courseName || ''),
      title: row.title,
      summary: String(row.metadata?.summary || ''),
      lessons: Array.isArray(row.metadata?.lessons) ? row.metadata.lessons : [],
      artifact: row.metadata?.artifact || null,
      status: privateTopicStatus(row, noteBySlug),
      updatedAt: row.updated_at
    }))
    return {
      notes: notes.map(row => ({
        id: row.id,
        title: row.title,
        courseName: String(row.metadata?.courseName || ''),
        lessonTitle: String(row.metadata?.lessonTitle || row.title || ''),
        lessonDate: String(row.metadata?.lessonDate || ''),
        replayKey: String(row.metadata?.replayKey || ''),
        slug: String(row.metadata?.slug || ''),
        checksum: String(row.metadata?.checksum || ''),
        index: row.metadata?.index || null,
        status: row.status,
        updatedAt: row.updated_at
      })),
      topics
    }
  }

  async function privateNote(ownerId, id) {
    const { data, error } = await supabase.from('notes')
      .select('id,title,body_markdown,note_type,status,metadata,created_at,updated_at')
      .eq('owner_id', ownerId).eq('id', id).maybeSingle()
    if (error) throw error
    return data || null
  }

  async function savePrivateTopic(ownerId, input) {
    const artifact = input?.artifact && typeof input.artifact === 'object' ? input.artifact : null
    const topicId = String(input.topicId || artifact?.id || '')
    if (!topicId || !artifact) throw new Error('专题缺 topicId 或 artifact')
    const metadata = {
      topicId,
      courseName: String(input.courseName || artifact.course || ''),
      summary: String(input.summary || artifact.summary || ''),
      lessons: Array.isArray(artifact.lessons) ? artifact.lessons.map(item => String(item?.slug || item || '')).filter(Boolean) : [],
      artifact,
      source: 'course-worker',
      updatedFromCourseAt: new Date().toISOString()
    }
    const { data: existing, error: readError } = await supabase.from('notes')
      .select('id').eq('owner_id', ownerId).eq('note_type', 'course-topic')
      .contains('metadata', { topicId }).maybeSingle()
    if (readError) throw readError
    const row = {
      title: String(input.title || artifact.title || '专题整合'),
      body_markdown: String(input.markdown || ''),
      note_type: 'course-topic',
      status: 'published',
      metadata,
      updated_at: new Date().toISOString()
    }
    if (existing) {
      const { data, error } = await supabase.from('notes').update(row)
        .eq('id', existing.id).eq('owner_id', ownerId).select('*').single()
      if (error) throw error
      return data
    }
    const { data, error } = await supabase.from('notes').insert({ owner_id: ownerId, ...row }).select('*').single()
    if (error) throw error
    return data
  }

  async function deletePrivateTopic(ownerId, id) {
    const { data, error } = await supabase.from('notes').delete()
      .eq('owner_id', ownerId).eq('note_type', 'course-topic').eq('id', id).select('id')
    if (error) throw error
    return Boolean(data?.length)
  }

  async function createMaterial(ownerId, input) {
    const { data, error } = await supabase.from('course_user_materials').insert({
      owner_id: ownerId,
      title: String(input.title || '课件'),
      storage_path: String(input.storagePath || ''),
      mime_type: String(input.mimeType || 'application/octet-stream'),
      status: 'uploaded',
      metadata: {
        courseName: String(input.courseName || ''),
        lessonTitle: String(input.lessonTitle || ''),
        replayKey: String(input.replayKey || ''),
        bytes: Number(input.bytes || 0),
        status: 'uploaded'
      }
    }).select('*').single()
    if (error) throw error
    return data
  }

  async function getMaterial(ownerId, id) {
    const { data, error } = await supabase.from('course_user_materials').select('*')
      .eq('owner_id', ownerId).eq('id', id).single()
    if (error) throw error
    return data
  }

  async function markMaterial(ownerId, id, metadata) {
    const current = await getMaterial(ownerId, id)
    const nextStatus = ['uploaded', 'processing', 'processed', 'failed'].includes(metadata?.status)
      ? metadata.status
      : current.status
    const { data, error } = await supabase.from('course_user_materials').update({
      status: nextStatus,
      metadata: { ...(current.metadata || {}), ...metadata },
      updated_at: new Date().toISOString()
    }).eq('owner_id', ownerId).eq('id', id).select('*').single()
    if (error) throw error
    return data
  }

  return {
    profile, setNotificationEmail, credentialStatus, credentials, putCredential, deleteCredential,
    getPkuConnection, pkuSecrets, putPkuPassword, savePkuSession, markPku,
    deletePkuPassword, setPkuSelection, saveScannedCourses, resourceLimits,
    notifyEmail, autoSyncOwners, savePrivateNote, privateNotes, privateContent, privateNote,
    savePrivateTopic, deletePrivateTopic, createMaterial, getMaterial, markMaterial
  }
}

export function validateCourseSelection(selected, scanned) {
  if (!Array.isArray(selected) || selected.some(key => typeof key !== 'string' || !scanned.includes(key))) {
    throw Object.assign(new Error('只能选择当前账户已扫描的课程'), {status:400})
  }
  return [...new Set(selected)]
}
