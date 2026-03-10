const https = require('https');

const CONFIG = {
  MIXPANEL_TOKEN: process.env.MIXPANEL_TOKEN,
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 1000,
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
  return payload.global_properties?.MDistinctID || null;
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

// Recursively flatten nested objects into dot-notation keys
// e.g. { event_arguments: { login_method: "google" } }
//   → { "$singular_event_arguments.login_method": "google" }
// Skips values that are still objects after flattening (e.g. { ValueType: 1 })
function flattenObject(obj, prefix = '') {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const flatKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)) {
      // Recurse into nested object
      const nested = flattenObject(value, flatKey);
      // Only keep scalar leaf values
      for (const [nestedKey, nestedValue] of Object.entries(nested)) {
        if (typeof nestedValue !== 'object') {
          result[nestedKey] = nestedValue;
        }
      }
    } else if (Array.isArray(value)) {
      // Convert arrays to JSON string
      result[flatKey] = JSON.stringify(value);
    } else {
      result[flatKey] = value;
    }
  }
  return result;
}

function mapFields(payload) {
  const props = {};

  // Map known fields via FIELD_MAPPING
  for (const [singularField, mixpanelField] of Object.entries(FIELD_MAPPING)) {
    if (payload[singularField] !== undefined && payload[singularField] !== null) {
      props[mixpanelField] = payload[singularField];
    }
  }

  // Special fields
  if (payload.install_utc_timestamp) {
    props.install_time = new Date(payload.install_utc_timestamp * 1000).toISOString();
  }
  if (payload.is_viewthrough !== undefined) {
    props.attribution_touch = payload.is_viewthrough === 1 ? 'view' : 'click';
  }

  // Catch-all — flatten nested objects, only store scalar values
  for (const [key, value] of Object.entries(payload)) {
    if (FIELD_MAPPING[key]) continue;               // already mapped
    if (key === 'install_utc_timestamp') continue;  // already mapped
    if (key === 'is_viewthrough') continue;          // already mapped

    if (value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)) {
      // Flatten nested object — e.g. global_properties, event_arguments
      const flattened = flattenObject(value, key);
      for (const [flatKey, flatValue] of Object.entries(flattened)) {
        if (typeof flatValue !== 'object' && flatValue !== null && flatValue !== undefined) {
          props[`$singular_${flatKey}`] = flatValue;
        }
      }
    } else {
      // Scalar value — store directly
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

    let payload;
    if (req.body) {
      payload = req.body;
      console.log('[PAYLOAD] Received from body:', JSON.stringify(req.body));
    } else if (req.query) {
      payload = req.query;
      console.log('[PAYLOAD] Received from query:', JSON.stringify(req.query));
    } else {
      console.error('[PAYLOAD ERROR] No payload received');
      return res.status(400).json({ error: 'No payload' });
    }

    const distinctId = getDistinctId(payload);
    if (!distinctId) {
      console.error('[VALIDATION ERROR] No MDistinctID found in global_properties');
      return res.status(400).json({ error: 'No MDistinctID in global_properties' });
    }
    console.log(`[VALIDATION] ✓ MDistinctID: ${distinctId}`);

    const eventName = getEventName(payload);
    const properties = mapFields(payload);

    console.log('[INFO] Processing details:', JSON.stringify({
      event: eventName,
      distinct_id: distinctId,
      campaign: payload.campaign || 'none',
      network: payload.network || 'none',
      is_organic: payload.is_organic,
      properties_count: Object.keys(properties).length
    }, null, 2));

    let attempt = 0;

    while (attempt < CONFIG.MAX_RETRIES) {
      try {
        attempt++;
        console.log(`\n[ATTEMPT ${attempt}/${CONFIG.MAX_RETRIES}] Starting Mixpanel operations...`);

        // Step 1: Set user properties directly on SDK profile
        console.log(`[STEP 1] Setting user properties on ${distinctId}...`);
        await setUserProperties(distinctId, properties);
        console.log('[STEP 1] ✓ User properties set successfully');

        // Step 2: Track event on SDK profile
        console.log(`[STEP 2] Tracking event "${eventName}" on ${distinctId}...`);
        await trackEvent(distinctId, eventName, properties);
        console.log('[STEP 2] ✓ Event tracked successfully');

        const duration = Date.now() - startTime;
        console.log(`\n[SUCCESS] === ALL OPERATIONS COMPLETED IN ${duration}ms ===`);

        const responseData = {
          success: true,
          event: eventName,
          distinct_id: distinctId,
          duration_ms: duration,
          attempts: attempt
        };

        console.log('[SUMMARY]', JSON.stringify(responseData, null, 2));
        return res.status(200).json(responseData);

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
