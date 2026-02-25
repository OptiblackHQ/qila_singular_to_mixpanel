const https = require('https');

const CONFIG = {
  MIXPANEL_TOKEN: process.env.MIXPANEL_TOKEN,
  MIXPANEL_API_SECRET: process.env.MIXPANEL_API_SECRET,
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 1000
};

const FIELD_MAPPING = {
  campaign: 'mp_campaign',
  network: 'mp_source',
  site: 'mp_site',
  tracker_name: 'mp_tracker',
  aifa: 'gps_adid',  
  idfa: 'idfa',    
  idfv: 'idfv',    
  gaid: 'gps_adid',  
  platform: 'platform',
  os_version: 'os_version',
  device_brand: 'device_brand',
  device_model: 'device_model',
  city: 'city',
  country: 'country',
  app_name: 'app_name',
  app_version: 'app_version'
};

function getDistinctId(payload) {
  return payload.user_id || payload.aifa || payload.idfa || payload.gaid || payload.idfv || null;
}

function getDeviceId(payload) {
  return payload.aifa || payload.gaid || payload.idfa || payload.idfv || null;
}

function getPlatform(payload) {
  return (payload.platform || '').toLowerCase();
}

function getEventName(payload) {
  const eventName = (payload.event_name || '').toLowerCase();
  if (eventName === '__start__') {
    return payload.is_reengagement === 1 ? 'reengagement' : 'install';
  }
  if (payload.event_name === 'login_completed_event' || payload.event_name === 'sign_up_completed_event') {
    return 'attribution_received';
  }
  return payload.event_name || 'unknown_event';
}

function mapFields(payload) {
  const props = {};
  for (const [singularField, mixpanelField] of Object.entries(FIELD_MAPPING)) {
    if (payload[singularField] !== undefined && payload[singularField] !== null) {
      props[mixpanelField] = payload[singularField];
    }
  }
  if (payload.install_utc_timestamp) {
    props.install_time = new Date(payload.install_utc_timestamp * 1000).toISOString();
  }
  if (payload.is_viewthrough !== undefined) {
    props.attribution_touch = payload.is_viewthrough === 1 ? 'view' : 'click';
  }
  for (const [key, value] of Object.entries(payload)) {
    if (!FIELD_MAPPING[key] && key !== 'install_utc_timestamp' && key !== 'is_viewthrough') {
      props[`$singular_${key}`] = value;
    }
  }
  props.$attribution_source = 'singular';
  props.$attribution_timestamp = new Date().toISOString();
  return props;
}

function callMixpanel(endpoint, data) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(data)).toString('base64');
    const options = {
      hostname: 'api.mixpanel.com',
      port: 443,
      path: `/${endpoint}?data=${encodeURIComponent(payload)}`,
      method: 'GET'
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve({ success: true, body });
        } else {
          reject(new Error(`Mixpanel ${endpoint} error: ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Query Mixpanel to find SDK profile by device ID
function queryProfileByDeviceId(deviceId, platform) {
  return new Promise((resolve, reject) => {
    // Determine property name based on platform
    const propertyName = (platform === 'android') ? 'gps_adid' : 'idfa';
   
    const whereClause = `properties["${propertyName}"] == "${deviceId}"`;
    const queryParams = JSON.stringify({
      where: whereClause
    });
   
    const encodedParams = Buffer.from(queryParams).toString('base64');
   
    const options = {
      hostname: 'mixpanel.com',
      port: 443,
      path: `/api/2.0/engage?data=${encodeURIComponent(encodedParams)}`,
      method: 'GET',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(CONFIG.MIXPANEL_API_SECRET + ':').toString('base64')
      }
    };
   
    console.log(`[QUERY] Searching for profile with ${propertyName} = ${deviceId}`);
   
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.results && data.results.length > 0) {
            const sdkDistinctId = data.results[0].$distinct_id;
            console.log(`[QUERY] ✓ Found SDK profile: ${sdkDistinctId}`);
            resolve({ found: true, sdk_distinct_id: sdkDistinctId });
          } else {
            console.log(`[QUERY] No SDK profile found with ${propertyName} = ${deviceId}`);
            resolve({ found: false });
          }
        } catch (e) {
          console.error('[QUERY] Parse error:', e.message);
          resolve({ found: false });
        }
      });
    });
   
    req.on('error', (err) => {
      console.error('[QUERY] Request error:', err.message);
      resolve({ found: false });
    });
   
    req.setTimeout(5000, () => {
      req.destroy();
      console.log('[QUERY] Timeout - continuing without merge');
      resolve({ found: false });
    });
   
    req.end();
  });
}

function aliasUser(fromDistinctId, toDistinctId) {
  console.log(`[ALIAS] Merging: ${fromDistinctId} -> ${toDistinctId}`);
  return callMixpanel('track', {
    event: '$create_alias',
    properties: {
      token: CONFIG.MIXPANEL_TOKEN,
      distinct_id: fromDistinctId,
      alias: toDistinctId
    }
  });
}

function setUserProperties(distinctId, properties) {
  return callMixpanel('engage', {
    $token: CONFIG.MIXPANEL_TOKEN,
    $distinct_id: distinctId,
    $set: properties
  });
}

function trackEvent(distinctId, eventName, properties) {
  return callMixpanel('track', {
    event: eventName,
    properties: {
      token: CONFIG.MIXPANEL_TOKEN,
      distinct_id: distinctId,
      time: Math.floor(Date.now() / 1000),
      ...properties
    }
  });
}

exports.singularMixpanel = async (req, res) => {
  const startTime = Date.now();
  console.log('=== SINGULAR WEBHOOK START ===');
 
  try {
    if (!CONFIG.MIXPANEL_TOKEN) {
      console.error('[CONFIG ERROR] MIXPANEL_TOKEN not configured');
      return res.status(500).json({ error: 'Token not configured' });
    }
    console.log('[CONFIG] ✓ MIXPANEL_TOKEN configured');
   
    if (!CONFIG.MIXPANEL_API_SECRET) {
      console.warn('[CONFIG WARNING] MIXPANEL_API_SECRET not configured - profile merging will be skipped');
    } else {
      console.log('[CONFIG] ✓ MIXPANEL_API_SECRET configured');
    }
   
    let payload;
    if (req.body) {
      payload = req.body;
      console.log('[PAYLOAD] Received from body:', JSON.stringify(req.body, null, 2));
    } else if (req.query) {
      payload = req.query;
      console.log('[PAYLOAD] Received from query:', JSON.stringify(req.query, null, 2));
    } else {
      console.error('[PAYLOAD ERROR] No payload received');
      return res.status(400).json({ error: 'No payload' });
    }
   
    const distinctId = getDistinctId(payload);
    if (!distinctId) {
      console.error('[VALIDATION ERROR] No distinct_id found in payload');
      return res.status(400).json({ error: 'No user identifier' });
    }
    console.log(`[VALIDATION] ✓ distinct_id found: ${distinctId}`);
   
    const deviceId = getDeviceId(payload);
    const platform = getPlatform(payload);
    const eventName = getEventName(payload);
    const properties = mapFields(payload);
    const hasUserId = !!payload.user_id;
    const hasDeviceId = !!deviceId;
    const needsUserAlias = hasUserId && hasDeviceId;
   
    console.log('[INFO] Processing details:', JSON.stringify({
      event: eventName,
      distinct_id: distinctId,
      device_id: deviceId,
      user_id: payload.user_id || null,
      platform: platform,
      needs_user_alias: needsUserAlias,
      campaign: payload.campaign || 'none',
      network: payload.network || 'none',
      is_organic: payload.is_organic,
      properties_count: Object.keys(properties).length
    }, null, 2));
   
    let attempt = 0;
    let sdkProfile = null;
    let profileMerged = false;
    let userAliased = false;
   
    while (attempt < CONFIG.MAX_RETRIES) {
      try {
        attempt++;
        console.log(`\n[ATTEMPT ${attempt}/${CONFIG.MAX_RETRIES}] Starting Mixpanel operations...`);
       
        // Step 1: Query for SDK profile (only on first attempt and if API secret is configured)
        if (attempt === 1 && CONFIG.MIXPANEL_API_SECRET && deviceId && platform) {
          console.log(`[STEP 1] Querying for SDK profile...`);
          sdkProfile = await queryProfileByDeviceId(deviceId, platform);
         
          if (sdkProfile.found) {
            console.log(`[STEP 1] ✓ SDK profile found: ${sdkProfile.sdk_distinct_id}`);
           
            // Step 2: If SDK profile found and different from advertising ID, merge them
            if (sdkProfile.sdk_distinct_id !== distinctId) {
              console.log(`[STEP 2] Attempting to merge profiles...`);
              console.log(`[STEP 2] From (advertising ID): ${distinctId}`);
              console.log(`[STEP 2] To (SDK profile): ${sdkProfile.sdk_distinct_id}`);
             
              try {
                // Use $create_alias to merge advertising ID profile into SDK profile
                await aliasUser(distinctId, sdkProfile.sdk_distinct_id);
                profileMerged = true;
                console.log('[STEP 2] ✓✓✓ PROFILES MERGED SUCCESSFULLY ✓✓✓');
               
                // Also set properties on SDK profile so it has attribution data
                console.log('[STEP 2] Setting properties on SDK profile...');
                await setUserProperties(sdkProfile.sdk_distinct_id, properties);
                console.log('[STEP 2] ✓ Properties set on SDK profile');
              } catch (mergeError) {
                console.error('[STEP 2] ✗ Profile merge failed:', mergeError.message);
                console.error('[STEP 2] Stack:', mergeError.stack);
                // Continue anyway
              }
            } else {
              console.log(`[STEP 2] Skipped - SDK distinct_id matches advertising ID (already same profile)`);
            }
          } else {
            console.log(`[STEP 1] ✗ No SDK profile found`);
            console.log(`[STEP 1] This means SDK hasn't set ${platform === 'android' ? 'gps_adid' : 'idfa'} property yet`);
          }
        } else {
          if (!CONFIG.MIXPANEL_API_SECRET) {
            console.log(`[STEP 1] Skipped - MIXPANEL_API_SECRET not configured`);
          } else if (!deviceId) {
            console.log(`[STEP 1] Skipped - No device ID in payload`);
          } else if (!platform) {
            console.log(`[STEP 1] Skipped - Platform not identified`);
          } else {
            console.log(`[STEP 1] Skipped - Only runs on first attempt`);
          }
        }
       
        // Step 3: Create user alias if user_id exists
        if (needsUserAlias && !userAliased) {
          console.log(`[STEP 3] Creating user alias...`);
          console.log(`[STEP 3] From: ${deviceId}`);
          console.log(`[STEP 3] To: ${payload.user_id}`);
         
          try {
            await aliasUser(deviceId, payload.user_id);
            userAliased = true;
            console.log('[STEP 3] ✓ User alias created successfully');
          } catch (aliasError) {
            console.error('[STEP 3] ✗ User alias failed:', aliasError.message);
            // Continue anyway
          }
        } else {
          if (!needsUserAlias) {
            console.log(`[STEP 3] Skipped - No user_id in payload or no device_id`);
          } else {
            console.log(`[STEP 3] Skipped - Already aliased in previous attempt`);
          }
        }
       
        // Step 4: Set properties on advertising ID profile
        console.log(`[STEP 4] Setting user properties on advertising ID profile (${distinctId})...`);
        await setUserProperties(distinctId, properties);
        console.log('[STEP 4] ✓ User properties set successfully');
       
        // Step 5: Track event
        console.log(`[STEP 5] Tracking event "${eventName}" on ${distinctId}...`);
        await trackEvent(distinctId, eventName, properties);
        console.log('[STEP 5] ✓ Event tracked successfully');
       
        const duration = Date.now() - startTime;
        console.log(`\n[SUCCESS] === ALL OPERATIONS COMPLETED IN ${duration}ms ===`);
        console.log('[SUMMARY]', JSON.stringify({
          success: true,
          event: eventName,
          distinct_id: distinctId,
          sdk_profile_found: sdkProfile?.found || false,
          sdk_distinct_id: sdkProfile?.sdk_distinct_id || null,
          profiles_merged: profileMerged,
          user_aliased: userAliased,
          duration_ms: duration,
          attempts: attempt
        }, null, 2));
       
        return res.status(200).json({
          success: true,
          event: eventName,
          distinct_id: distinctId,
          sdk_profile_found: sdkProfile?.found || false,
          sdk_distinct_id: sdkProfile?.sdk_distinct_id || null,
          profiles_merged: profileMerged,
          user_aliased: userAliased,
          duration_ms: duration,
          attempts: attempt
        });
       
      } catch (error) {
        console.error(`\n[ATTEMPT ${attempt}] ✗✗✗ FAILED ✗✗✗`);
        console.error(`[ATTEMPT ${attempt}] Error:`, error.message);
        console.error(`[ATTEMPT ${attempt}] Stack:`, error.stack);
       
        if (attempt >= CONFIG.MAX_RETRIES) {
          console.error(`[FATAL] Max retries (${CONFIG.MAX_RETRIES}) reached. Giving up.`);
          throw error;
        }
       
        const delay = CONFIG.RETRY_DELAY_MS * attempt;
        console.log(`[RETRY] Waiting ${delay}ms before retry ${attempt + 1}...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
   
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error('[FATAL ERROR] === PROCESSING FAILED ===');
    console.error('[FATAL ERROR] Message:', error.message);
    console.error('[FATAL ERROR] Stack:', error.stack);
    console.error('[FATAL ERROR] Duration:', duration, 'ms');
   
    return res.status(500).json({
      success: false,
      error: error.message,
      duration_ms: duration
    });
  } finally {
    console.log('=== SINGULAR WEBHOOK END ===\n');
  }
};
