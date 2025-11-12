require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const { OpenAI } = require('openai');
const app = express();
const PORT = process.env.PORT || 3001;
// Path to local DB file (useful when mounting a persistent disk on Render)
const DB_PATH = process.env.DB_PATH || './polai.db';

console.log('DB_PATH:', DB_PATH);
// Middleware
app.use(cors());
app.use(express.json());
// AI Provider Configuration
const AI_PROVIDER = process.env.AI_PROVIDER || 'mistral';
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Initialize OpenAI client (if used)
let openai = null;
if (AI_PROVIDER === 'openai') {
    if (!OPENAI_API_KEY) {
        console.warn('⚠️ OPENAI_API_KEY not set - OpenAI provider will fail');
    } else {
        openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    }
}
console.log('=== PolAI Backend Started ===');
console.log('AI Provider:', AI_PROVIDER);
console.log('Mistral API Key:', MISTRAL_API_KEY ? '✓ Configured' : '✗ Missing');
console.log('OpenAI API Key:', OPENAI_API_KEY ? '✓ Configured' : '✗ Missing');
console.log('=============================');
// Enhanced headers for different sites
const getHeaders = (url) => {
    const baseHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Cache-Control': 'max-age=0'
    };
    return baseHeaders;
};
// URL validation and normalization
const normalizeUrl = (url) => {
    if (!url) throw new Error('URL is required');
   
    let cleanUrl = url.trim().replace(/^(https?:\/\/\s*)+/i, 'https://');
   
    if (!cleanUrl.startsWith('http')) {
        cleanUrl = 'https://' + cleanUrl;
    }
   
    try {
        const urlObj = new URL(cleanUrl);
        return urlObj.href;
    } catch (error) {
        throw new Error(`Invalid URL: ${cleanUrl}`);
    }
};
// Enhanced policy extraction with retry logic
async function extractPolicyText(url, retries = 3) {
    const normalizedUrl = normalizeUrl(url);
    console.log(`📄 Extracting policy from: ${normalizedUrl}`);
   
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await axios.get(normalizedUrl, {
                headers: getHeaders(normalizedUrl),
                timeout: 30000,
                validateStatus: function (status) {
                    return status >= 200 && status < 400;
                }
            });
            const $ = cheerio.load(response.data);
           
            // Remove unwanted elements
            $('script, style, nav, header, footer, iframe, noscript').remove();
           
            // Enhanced content selectors
            const contentSelectors = [
                'main',
                '[role="main"]',
                '.privacy-policy',
                '.privacy-content',
                '.policy-content',
                '#privacy-policy',
                '#privacy',
                '.legal-content',
                '.terms-content',
                'article',
                '.content',
                '.main-content',
                '.page-content',
                '.container',
                '#content'
            ];
            let policyText = '';
           
            for (const selector of contentSelectors) {
                const content = $(selector);
                if (content.length > 0) {
                    policyText = content.text();
                    if (policyText.length > 500) break;
                }
            }
            // Fallback to body
            if (policyText.length < 500) {
                policyText = $('body').text();
            }
            // Clean up the text
            policyText = policyText
                .replace(/\s+/g, ' ')
                .replace(/\n+/g, '\n')
                .trim();
            if (!policyText || policyText.length < 100) {
                throw new Error('No substantial policy text found');
            }
            console.log(`✓ Extracted ${policyText.length} characters`);
            return policyText;
        } catch (error) {
            console.log(`✗ Attempt ${attempt}/${retries} failed: ${error.message}`);
           
            if (attempt === retries) {
                throw new Error(`Failed to extract policy after ${retries} attempts: ${error.message}`);
            }
           
            await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
    }
}
// Enhanced Mistral AI response parser
function parseMistralResponse(response) {
    if (!response) {
        throw new Error('Empty response from Mistral AI');
    }
    try {
        return JSON.parse(response);
    } catch (firstError) {
        try {
            // Try to extract JSON from markdown code blocks
            const jsonMatch = response.match(/```json\n([\s\S]*?)\n```/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[1]);
            }
           
            const alternativeMatch = response.match(/```\n([\s\S]*?)\n```/);
            if (alternativeMatch) {
                return JSON.parse(alternativeMatch[1]);
            }
           
            const jsonObjectMatch = response.match(/\{[\s\S]*\}/);
            if (jsonObjectMatch) {
                return JSON.parse(jsonObjectMatch[0]);
            }
           
            throw new Error('No valid JSON found in response');
        } catch (secondError) {
            console.error('Failed to parse Mistral response:', response.substring(0, 500));
            throw new Error(`Mistral AI response parsing failed: ${secondError.message}`);
        }
    }
}
// ENHANCED: Analyze policy with Mistral AI - Improved Prompt with Chunking Support
async function analyzePolicyWithMistral(policyText, policyUrl) {
    if (!MISTRAL_API_KEY) {
        throw new Error('Mistral API key not configured');
    }
    // Calculate approximate token count (rough estimate: 1 token ≈ 4 characters)
    const estimatedTokens = Math.ceil(policyText.length / 4);
    const maxInputTokens = 12000; // Conservative limit for Mistral free tier (leaves room for prompt + response)
   
    console.log(`📊 Estimated tokens: ${estimatedTokens}`);
    // If policy is small enough, analyze in one go
    if (estimatedTokens <= maxInputTokens) {
        console.log('✓ Policy size within limits, analyzing in single request');
        return await analyzeSingleChunk(policyText, policyUrl);
    }
    // Policy is too large, need to chunk it
    console.log('⚠️ Policy exceeds token limit, splitting into chunks...');
    return await analyzeInChunks(policyText, policyUrl, maxInputTokens);
}
// Analyze policy in a single request
async function analyzeSingleChunk(policyText, policyUrl) {
    const prompt = `You are an expert privacy policy analyst. Analyze this privacy policy thoroughly and provide a detailed JSON response.
IMPORTANT SCORING GUIDELINES:
- Be objective and fair in your assessment
- Consider both positive and negative aspects
- Data collection is NOT inherently bad - evaluate HOW it's handled
- Transparency and user control are key positive indicators
- Strong user rights significantly improve the score
Required JSON Structure:
{
  "summary": "2-3 sentence overview highlighting key points and overall privacy posture",
  "data_collection": {
    "types": ["array of specific data types collected"],
    "purposes": ["array of specific purposes for collection"],
    "transparency_score": 0-10,
    "justification": "Brief explanation of data collection practices"
  },
  "user_rights": {
    "access": true/false,
    "deletion": true/false,
    "correction": true/false,
    "portability": true/false,
    "opt_out": true/false,
    "opt_out_methods": ["methods available for opting out"],
    "rights_score": 0-10,
    "details": "Explanation of how rights are implemented"
  },
  "data_sharing": {
    "third_parties": true/false,
    "third_party_purposes": ["purposes for sharing"],
    "international_transfers": true/false,
    "transfer_safeguards": ["safeguards mentioned"],
    "law_enforcement": true/false,
    "user_control": true/false,
    "sharing_score": 0-10
  },
  "cookies_tracking": {
    "cookies_used": true/false,
    "tracking_technologies": ["list of technologies"],
    "opt_out_available": true/false,
    "granular_controls": false/true,
    "tracking_score": 0-10
  },
  "security_measures": {
    "measures": ["specific security measures mentioned"],
    "encryption_mentioned": true/false,
    "access_controls": true/false,
    "incident_response": true/false,
    "security_score": 0-10
  },
  "policy_updates": {
    "notification_method": "how users are notified",
    "frequency_mentioned": true/false,
    "user_consent_required": true/false
  },
  "compliance": {
    "gdpr_mentioned": true/false,
    "ccpa_mentioned": true/false,
    "coppa_mentioned": true/false,
    "other_regulations": ["list"],
    "compliance_score": 0-10
  },
  "contact_info": {
    "provided": true/false,
    "methods": ["available contact methods"],
    "dpo_mentioned": true/false
  },
  "transparency": {
    "clear_language": true/false,
    "easy_to_find": true/false,
    "well_organized": true/false,
    "specific_examples": true/false,
    "transparency_score": 0-10
  },
  "data_retention": {
    "retention_period_specified": true/false,
    "deletion_process_clear": true/false,
    "retention_score": 0-10
  }
}
Privacy Policy URL: ${policyUrl}
Policy Text:
${policyText.substring(0, 48000)}
Respond with ONLY valid JSON. No markdown formatting. Be thorough and fair in your evaluation.`;
    try {
        console.log('🤖 Sending single request to Mistral AI...');
       
        const response = await axios.post('https://api.mistral.ai/v1/chat/completions', {
            model: 'mistral-medium',
            messages: [
                {
                    role: 'system',
                    content: 'You are an expert privacy policy analyst. Provide objective, fair, and detailed analysis. Return ONLY valid JSON with no markdown formatting.'
                },
                {
                    role: 'user',
                    content: prompt
                }
            ],
            temperature: 0.2,
            max_tokens: 6000
        }, {
            headers: {
                'Authorization': `Bearer ${MISTRAL_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 90000
        });
        const aiResponse = response.data.choices[0].message.content;
        const parsed = parseMistralResponse(aiResponse);
       
        console.log('✓ Mistral analysis complete');
        return parsed;
    } catch (error) {
        console.error('✗ Mistral AI error:', error.response?.data || error.message);
        throw new Error(`Mistral AI API failed: ${error.message}`);
    }
}
// Analyze policy in chunks and merge results
async function analyzeInChunks(policyText, policyUrl, maxInputTokens) {
    // Split text into chunks (conservative character limit based on token estimate)
    const maxCharsPerChunk = maxInputTokens * 3.5; // ~3.5 chars per token
    const chunks = [];
   
    let currentPos = 0;
    while (currentPos < policyText.length) {
        let endPos = Math.min(currentPos + maxCharsPerChunk, policyText.length);
       
        // Try to break at a sentence or paragraph boundary
        if (endPos < policyText.length) {
            const lastPeriod = policyText.lastIndexOf('.', endPos);
            const lastNewline = policyText.lastIndexOf('\n', endPos);
            const breakPoint = Math.max(lastPeriod, lastNewline);
           
            if (breakPoint > currentPos + (maxCharsPerChunk * 0.7)) {
                endPos = breakPoint + 1;
            }
        }
       
        chunks.push(policyText.substring(currentPos, endPos));
        currentPos = endPos;
    }
   
    console.log(`📦 Split into ${chunks.length} chunks`);
   
    // Analyze each chunk
    const chunkAnalyses = [];
    for (let i = 0; i < chunks.length; i++) {
        console.log(`🔍 Analyzing chunk ${i + 1}/${chunks.length}...`);
       
        try {
            const analysis = await analyzeChunk(chunks[i], policyUrl, i + 1, chunks.length);
            chunkAnalyses.push(analysis);
           
            // Rate limiting: wait between requests
            if (i < chunks.length - 1) {
                console.log('⏳ Waiting 2s before next chunk...');
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        } catch (error) {
            console.error(`✗ Chunk ${i + 1} failed:`, error.message);
            // Continue with other chunks even if one fails
            chunkAnalyses.push(null);
        }
    }
   
    // Merge chunk analyses
    console.log('🔄 Merging chunk analyses...');
    return mergeChunkAnalyses(chunkAnalyses, policyUrl);
}
// Analyze a single chunk
async function analyzeChunk(chunkText, policyUrl, chunkNum, totalChunks) {
    const prompt = `You are analyzing part ${chunkNum} of ${totalChunks} of a privacy policy. Extract ALL relevant information from this section.
Focus on finding:
- Data types collected
- Purposes for collection
- User rights mentioned
- Third-party sharing details
- Security measures
- Tracking technologies
- Compliance regulations
- Contact information
- Any other privacy-relevant details
Return a JSON object with any fields you can determine from this section. Use the same structure as a full analysis, but only include fields where you found information. Mark boolean fields as true if mentioned, false if explicitly denied, or omit if not mentioned.
Policy Section (Part ${chunkNum}/${totalChunks}):
${chunkText.substring(0, 14000)}
Respond with ONLY valid JSON. Include only fields where you found relevant information.`;
    try {
        const response = await axios.post('https://api.mistral.ai/v1/chat/completions', {
            model: 'mistral-medium',
            messages: [
                {
                    role: 'system',
                    content: 'Extract privacy policy information from the provided text section. Return ONLY valid JSON.'
                },
                {
                    role: 'user',
                    content: prompt
                }
            ],
            temperature: 0.2,
            max_tokens: 4000
        }, {
            headers: {
                'Authorization': `Bearer ${MISTRAL_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 90000
        });
        const aiResponse = response.data.choices[0].message.content;
        return parseMistralResponse(aiResponse);
    } catch (error) {
        console.error(`✗ Chunk ${chunkNum} analysis error:`, error.response?.data || error.message);
        throw error;
    }
}
// Merge multiple chunk analyses into a single comprehensive analysis
function mergeChunkAnalyses(chunkAnalyses, policyUrl) {
    console.log('🔧 Merging analyses from chunks...');
   
    // Filter out failed chunks
    const validAnalyses = chunkAnalyses.filter(a => a !== null);
   
    if (validAnalyses.length === 0) {
        throw new Error('All chunk analyses failed');
    }
   
    // Initialize merged result
    const merged = {
        summary: '',
        data_collection: {
            types: [],
            purposes: [],
            transparency_score: 0,
            justification: ''
        },
        user_rights: {
            access: false,
            deletion: false,
            correction: false,
            portability: false,
            opt_out: false,
            opt_out_methods: [],
            rights_score: 0,
            details: ''
        },
        data_sharing: {
            third_parties: false,
            third_party_purposes: [],
            international_transfers: false,
            transfer_safeguards: [],
            law_enforcement: false,
            user_control: false,
            sharing_score: 0
        },
        cookies_tracking: {
            cookies_used: false,
            tracking_technologies: [],
            opt_out_available: false,
            granular_controls: false,
            tracking_score: 0
        },
        security_measures: {
            measures: [],
            encryption_mentioned: false,
            access_controls: false,
            incident_response: false,
            security_score: 0
        },
        policy_updates: {
            notification_method: 'Not specified',
            frequency_mentioned: false,
            user_consent_required: false
        },
        compliance: {
            gdpr_mentioned: false,
            ccpa_mentioned: false,
            coppa_mentioned: false,
            other_regulations: [],
            compliance_score: 0
        },
        contact_info: {
            provided: false,
            methods: [],
            dpo_mentioned: false
        },
        transparency: {
            clear_language: false,
            easy_to_find: false,
            well_organized: false,
            specific_examples: false,
            transparency_score: 0
        },
        data_retention: {
            retention_period_specified: false,
            deletion_process_clear: false,
            retention_score: 0
        }
    };
   
    // Merge each chunk's findings
    validAnalyses.forEach((analysis, idx) => {
        // Merge arrays (deduplicate)
        if (analysis.data_collection?.types) {
            merged.data_collection.types = [...new Set([...merged.data_collection.types, ...analysis.data_collection.types])];
        }
        if (analysis.data_collection?.purposes) {
            merged.data_collection.purposes = [...new Set([...merged.data_collection.purposes, ...analysis.data_collection.purposes])];
        }
        if (analysis.data_sharing?.third_party_purposes) {
            merged.data_sharing.third_party_purposes = [...new Set([...merged.data_sharing.third_party_purposes, ...analysis.data_sharing.third_party_purposes])];
        }
        if (analysis.data_sharing?.transfer_safeguards) {
            merged.data_sharing.transfer_safeguards = [...new Set([...merged.data_sharing.transfer_safeguards, ...analysis.data_sharing.transfer_safeguards])];
        }
        if (analysis.cookies_tracking?.tracking_technologies) {
            merged.cookies_tracking.tracking_technologies = [...new Set([...merged.cookies_tracking.tracking_technologies, ...analysis.cookies_tracking.tracking_technologies])];
        }
        if (analysis.security_measures?.measures) {
            merged.security_measures.measures = [...new Set([...merged.security_measures.measures, ...analysis.security_measures.measures])];
        }
        if (analysis.compliance?.other_regulations) {
            merged.compliance.other_regulations = [...new Set([...merged.compliance.other_regulations, ...analysis.compliance.other_regulations])];
        }
        if (analysis.contact_info?.methods) {
            merged.contact_info.methods = [...new Set([...merged.contact_info.methods, ...analysis.contact_info.methods])];
        }
        if (analysis.user_rights?.opt_out_methods) {
            merged.user_rights.opt_out_methods = [...new Set([...merged.user_rights.opt_out_methods, ...analysis.user_rights.opt_out_methods])];
        }
       
        // Merge booleans (true if any chunk says true)
        if (analysis.user_rights?.access) merged.user_rights.access = true;
        if (analysis.user_rights?.deletion) merged.user_rights.deletion = true;
        if (analysis.user_rights?.correction) merged.user_rights.correction = true;
        if (analysis.user_rights?.portability) merged.user_rights.portability = true;
        if (analysis.user_rights?.opt_out) merged.user_rights.opt_out = true;
       
        if (analysis.data_sharing?.third_parties) merged.data_sharing.third_parties = true;
        if (analysis.data_sharing?.international_transfers) merged.data_sharing.international_transfers = true;
        if (analysis.data_sharing?.law_enforcement) merged.data_sharing.law_enforcement = true;
        if (analysis.data_sharing?.user_control) merged.data_sharing.user_control = true;
       
        if (analysis.cookies_tracking?.cookies_used) merged.cookies_tracking.cookies_used = true;
        if (analysis.cookies_tracking?.opt_out_available) merged.cookies_tracking.opt_out_available = true;
        if (analysis.cookies_tracking?.granular_controls) merged.cookies_tracking.granular_controls = true;
       
        if (analysis.security_measures?.encryption_mentioned) merged.security_measures.encryption_mentioned = true;
        if (analysis.security_measures?.access_controls) merged.security_measures.access_controls = true;
        if (analysis.security_measures?.incident_response) merged.security_measures.incident_response = true;
       
        if (analysis.policy_updates?.frequency_mentioned) merged.policy_updates.frequency_mentioned = true;
        if (analysis.policy_updates?.user_consent_required) merged.policy_updates.user_consent_required = true;
       
        if (analysis.compliance?.gdpr_mentioned) merged.compliance.gdpr_mentioned = true;
        if (analysis.compliance?.ccpa_mentioned) merged.compliance.ccpa_mentioned = true;
        if (analysis.compliance?.coppa_mentioned) merged.compliance.coppa_mentioned = true;
       
        if (analysis.contact_info?.provided) merged.contact_info.provided = true;
        if (analysis.contact_info?.dpo_mentioned) merged.contact_info.dpo_mentioned = true;
       
        if (analysis.transparency?.clear_language) merged.transparency.clear_language = true;
        if (analysis.transparency?.easy_to_find) merged.transparency.easy_to_find = true;
        if (analysis.transparency?.well_organized) merged.transparency.well_organized = true;
        if (analysis.transparency?.specific_examples) merged.transparency.specific_examples = true;
       
        if (analysis.data_retention?.retention_period_specified) merged.data_retention.retention_period_specified = true;
        if (analysis.data_retention?.deletion_process_clear) merged.data_retention.deletion_process_clear = true;
       
        // Take first non-empty notification method
        if (analysis.policy_updates?.notification_method && analysis.policy_updates.notification_method !== 'Not specified') {
            merged.policy_updates.notification_method = analysis.policy_updates.notification_method;
        }
       
        // Collect summary snippets
        if (analysis.summary && idx === 0) {
            merged.summary = analysis.summary;
        }
    });
   
    // Calculate average scores
    const scoreFields = [
        'data_collection.transparency_score',
        'user_rights.rights_score',
        'data_sharing.sharing_score',
        'cookies_tracking.tracking_score',
        'security_measures.security_score',
        'compliance.compliance_score',
        'transparency.transparency_score',
        'data_retention.retention_score'
    ];
   
    scoreFields.forEach(field => {
        const parts = field.split('.');
        const scores = validAnalyses
            .map(a => {
                const section = a[parts[0]];
                return section?.[parts[1]] || 0;
            })
            .filter(s => s > 0);
       
        if (scores.length > 0) {
            const avgScore = Math.round(scores.reduce((sum, s) => sum + s, 0) / scores.length);
            const section = merged[parts[0]];
            section[parts[1]] = avgScore;
        }
    });
   
    // Generate comprehensive summary if none exists
    if (!merged.summary) {
        merged.summary = `This privacy policy was analyzed across ${validAnalyses.length} sections. ` +
            `It ${merged.data_collection.types.length > 0 ? `collects ${merged.data_collection.types.length} types of data` : 'has limited data collection information'}, ` +
            `${merged.user_rights.deletion ? 'provides user deletion rights' : 'has limited user rights'}, and ` +
            `${merged.compliance.gdpr_mentioned || merged.compliance.ccpa_mentioned ? 'mentions major privacy regulations' : 'has minimal compliance information'}.`;
    }
   
    // Add justification
    merged.data_collection.justification = `Analysis merged from ${validAnalyses.length} policy sections. ` +
        `Collects ${merged.data_collection.types.length} data types for ${merged.data_collection.purposes.length} purposes.`;
   
    merged.user_rights.details = `User rights analysis: ${merged.user_rights.access ? 'Access granted' : 'No access mentioned'}, ` +
        `${merged.user_rights.deletion ? 'deletion available' : 'no deletion mentioned'}, ` +
        `${merged.user_rights.opt_out ? 'opt-out available' : 'no opt-out mentioned'}.`;
   
    console.log('✓ Merged analysis complete');
    console.log(` - Data types found: ${merged.data_collection.types.length}`);
    console.log(` - User rights: ${[merged.user_rights.access, merged.user_rights.deletion, merged.user_rights.opt_out].filter(Boolean).length}/5`);
    console.log(` - Compliance: ${[merged.compliance.gdpr_mentioned, merged.compliance.ccpa_mentioned].filter(Boolean).length} major regulations`);
   
    return merged;
}
// Analyze policy with OpenAI
async function analyzePolicyWithOpenAI(policyText, policyUrl) {
    if (!openai) {
        throw new Error('OpenAI client not initialized');
    }
    const prompt = `You are an expert privacy policy analyst. Analyze this privacy policy thoroughly and provide a detailed JSON response.
IMPORTANT SCORING GUIDELINES:
- Be objective and fair in your assessment
- Consider both positive and negative aspects
- Data collection is NOT inherently bad - evaluate HOW it's handled
- Transparency and user control are key positive indicators
- Strong user rights significantly improve the score
Required JSON Structure:
{
  "summary": "2-3 sentence overview highlighting key points and overall privacy posture",
  "data_collection": {
    "types": ["array of specific data types collected"],
    "purposes": ["array of specific purposes for collection"],
    "transparency_score": 0-10,
    "justification": "Brief explanation of data collection practices"
  },
  "user_rights": {
    "access": true/false,
    "deletion": true/false,
    "correction": true/false,
    "portability": true/false,
    "opt_out": true/false,
    "opt_out_methods": ["methods available for opting out"],
    "rights_score": 0-10,
    "details": "Explanation of how rights are implemented"
  },
  "data_sharing": {
    "third_parties": true/false,
    "third_party_purposes": ["purposes for sharing"],
    "international_transfers": true/false,
    "transfer_safeguards": ["safeguards mentioned"],
    "law_enforcement": true/false,
    "user_control": true/false,
    "sharing_score": 0-10
  },
  "cookies_tracking": {
    "cookies_used": true/false,
    "tracking_technologies": ["list of technologies"],
    "opt_out_available": true/false,
    "granular_controls": true/false,
    "tracking_score": 0-10
  },
  "security_measures": {
    "measures": ["specific security measures mentioned"],
    "encryption_mentioned": true/false,
    "access_controls": true/false,
    "incident_response": true/false,
    "security_score": 0-10
  },
  "policy_updates": {
    "notification_method": "how users are notified",
    "frequency_mentioned": true/false,
    "user_consent_required": true/false
  },
  "compliance": {
    "gdpr_mentioned": true/false,
    "ccpa_mentioned": true/false,
    "coppa_mentioned": true/false,
    "other_regulations": ["list"],
    "compliance_score": 0-10
  },
  "contact_info": {
    "provided": true/false,
    "methods": ["available contact methods"],
    "dpo_mentioned": true/false
  },
  "transparency": {
    "clear_language": true/false,
    "easy_to_find": true/false,
    "well_organized": true/false,
    "specific_examples": true/false,
    "transparency_score": 0-10
  },
  "data_retention": {
    "retention_period_specified": true/false,
    "deletion_process_clear": true/false,
    "retention_score": 0-10
  }
}
Privacy Policy URL: ${policyUrl}
Policy Text:
${policyText.substring(0, 20000)}`;
    try {
        console.log('🤖 Analyzing with OpenAI...');
       
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: 'You are an expert privacy policy analyst. Provide objective, fair, and detailed analysis. Return ONLY valid JSON.' },
                { role: 'user', content: prompt }
            ],
            max_tokens: 4000,
            temperature: 0.2,
            response_format: { type: "json_object" }
        });
        const aiResponse = completion.choices[0].message.content;
        console.log('✓ OpenAI analysis complete');
        return JSON.parse(aiResponse);
    } catch (error) {
        console.error('✗ OpenAI error:', error.response?.data || error.message);
        throw new Error(`OpenAI API failed: ${error.message}`);
    }
}
// ENHANCED: Rule-based fallback with improved scoring
function performRuleBasedAnalysis(policyText, policyUrl) {
    console.log('🔧 Performing enhanced rule-based analysis...');
   
    const text = policyText.toLowerCase();
   
    const dataTypes = detectDataTypes(text);
    const purposes = detectPurposes(text);
    const trackingTech = detectTrackingTechnologies(text);
    const securityMeasures = detectSecurityMeasures(text);
   
    // Calculate component scores
    const transparencyScore = calculateTransparencyScore(text);
    const rightsScore = calculateRightsScore(text);
    const sharingScore = calculateSharingScore(text);
    const securityScore = calculateSecurityScore(text, securityMeasures);
    const complianceScore = calculateComplianceScore(text);
    const trackingScore = calculateTrackingScore(text, trackingTech);
    const retentionScore = calculateRetentionScore(text);
   
    return {
        summary: generateSummary(text, transparencyScore, rightsScore, sharingScore),
        data_collection: {
            types: dataTypes,
            purposes: purposes,
            transparency_score: transparencyScore,
            justification: `Collects ${dataTypes.length} types of data for ${purposes.length} stated purposes`
        },
        user_rights: {
            access: text.includes('access') || text.includes('view your data') || text.includes('request access'),
            deletion: text.includes('delete') || text.includes('erase') || text.includes('right to be forgotten') || text.includes('remove your data'),
            correction: text.includes('correct') || text.includes('rectif') || text.includes('update your information'),
            portability: text.includes('portability') || text.includes('data portability') || text.includes('export your data'),
            opt_out: text.includes('opt') || text.includes('opt-out') || text.includes('unsubscribe') || text.includes('withdraw consent'),
            opt_out_methods: detectOptOutMethods(text),
            rights_score: rightsScore,
            details: describeUserRights(text)
        },
        data_sharing: {
            third_parties: text.includes('third') || text.includes('partner') || text.includes('share'),
            third_party_purposes: detectSharingPurposes(text),
            international_transfers: text.includes('international') || text.includes('transfer') || text.includes('cross-border'),
            transfer_safeguards: detectTransferSafeguards(text),
            law_enforcement: text.includes('law') || text.includes('legal') || text.includes('subpoena') || text.includes('court order'),
            user_control: text.includes('you can control') || text.includes('manage sharing') || text.includes('sharing preferences'),
            sharing_score: sharingScore
        },
        cookies_tracking: {
            cookies_used: text.includes('cooki') || text.includes('track'),
            tracking_technologies: trackingTech,
            opt_out_available: (text.includes('opt') || text.includes('disable')) && text.includes('cooki'),
            granular_controls: text.includes('cookie settings') || text.includes('manage cookies') || text.includes('cookie preferences'),
            tracking_score: trackingScore
        },
        security_measures: {
            measures: securityMeasures,
            encryption_mentioned: text.includes('encrypt'),
            access_controls: text.includes('access control') || text.includes('authentication'),
            incident_response: text.includes('breach') || text.includes('incident response') || text.includes('security incident'),
            security_score: securityScore
        },
        policy_updates: {
            notification_method: detectUpdateMethod(text),
            frequency_mentioned: text.includes('update') || text.includes('change') || text.includes('revise'),
            user_consent_required: text.includes('notify you') || text.includes('consent to changes')
        },
        compliance: {
            gdpr_mentioned: text.includes('gdpr') || text.includes('general data protection regulation'),
            ccpa_mentioned: text.includes('ccpa') || text.includes('california consumer privacy act'),
            coppa_mentioned: text.includes('coppa') || text.includes('children\'s online privacy'),
            other_regulations: detectOtherRegulations(text),
            compliance_score: complianceScore
        },
        contact_info: {
            provided: text.includes('contact') || text.includes('email') || text.includes('@'),
            methods: detectContactMethods(text),
            dpo_mentioned: text.includes('data protection officer') || text.includes('dpo') || text.includes('privacy officer')
        },
        transparency: {
            clear_language: text.length < 15000 && !text.includes('notwithstanding') && !text.includes('hereinafter'),
            easy_to_find: true,
            well_organized: text.includes('table of contents') || text.split('\n').length > 10,
            specific_examples: text.includes('for example') || text.includes('such as') || text.includes('including'),
            transparency_score: transparencyScore
        },
        data_retention: {
            retention_period_specified: text.includes('retain') && (text.includes('days') || text.includes('months') || text.includes('years')),
            deletion_process_clear: text.includes('delete') && text.includes('request'),
            retention_score: retentionScore
        },
        analysis_method: "enhanced_rule_based"
    };
}
// Helper functions for enhanced scoring
function calculateTransparencyScore(text) {
    let score = 5; // Start neutral
    if (text.includes('for example') || text.includes('such as')) score += 2;
    if (text.includes('table of contents')) score += 1;
    if (text.length < 10000) score += 1;
    if (text.includes('plain language') || text.includes('easy to understand')) score += 1;
    return Math.min(10, score);
}
function calculateRightsScore(text) {
    let score = 0;
    if (text.includes('access') && text.includes('your data')) score += 2;
    if (text.includes('delete') || text.includes('erase')) score += 3;
    if (text.includes('correct') || text.includes('update')) score += 1;
    if (text.includes('portability') || text.includes('export')) score += 2;
    if (text.includes('opt-out') || text.includes('withdraw consent')) score += 2;
    return Math.min(10, score);
}
function calculateSharingScore(text) {
    let score = 10; // Start high (less sharing is better)
    if (text.includes('sell') && text.includes('data')) score -= 4;
    if (text.includes('third party') || text.includes('third-party')) score -= 2;
    if (text.includes('advertising') && text.includes('share')) score -= 1;
    if (text.includes('you can control') || text.includes('opt-out')) score += 2;
    return Math.max(0, Math.min(10, score));
}
function calculateSecurityScore(text, measures) {
    let score = measures.length * 2;
    if (text.includes('encrypt')) score += 2;
    if (text.includes('ssl') || text.includes('tls')) score += 1;
    if (text.includes('two-factor') || text.includes('multi-factor')) score += 2;
    if (text.includes('regular audit') || text.includes('security testing')) score += 1;
    return Math.min(10, score);
}
function calculateComplianceScore(text) {
    let score = 0;
    if (text.includes('gdpr')) score += 3;
    if (text.includes('ccpa')) score += 3;
    if (text.includes('coppa')) score += 2;
    if (text.includes('hipaa')) score += 2;
    return Math.min(10, score);
}
function calculateTrackingScore(text, trackingTech) {
    let score = 10; // Start high (less tracking is better)
    score -= trackingTech.length;
    if (text.includes('opt-out') && text.includes('cooki')) score += 2;
    if (text.includes('do not track') || text.includes('dnt')) score += 1;
    return Math.max(0, Math.min(10, score));
}
function calculateRetentionScore(text) {
    let score = 5;
    if (text.includes('retain') && (text.includes('days') || text.includes('months') || text.includes('years'))) score += 3;
    if (text.includes('delete') && text.includes('inactive')) score += 2;
    return Math.min(10, score);
}
function generateSummary(text, transparencyScore, rightsScore, sharingScore) {
    const avgScore = (transparencyScore + rightsScore + sharingScore) / 3;
   
    if (avgScore >= 7) {
        return "This privacy policy demonstrates good transparency and user-centric practices. Clear data handling procedures and strong user rights are evident.";
    } else if (avgScore >= 5) {
        return "This privacy policy shows moderate transparency with some user rights. There are areas that could benefit from clearer explanations and stronger user protections.";
    } else {
        return "This privacy policy has limited transparency and user control. Users should carefully review data handling practices and consider privacy implications.";
    }
}
function describeUserRights(text) {
    const rights = [];
    if (text.includes('access')) rights.push('access');
    if (text.includes('delete')) rights.push('deletion');
    if (text.includes('correct')) rights.push('correction');
    if (text.includes('portability')) rights.push('portability');
    if (text.includes('opt')) rights.push('opt-out');
   
    if (rights.length === 0) return "Limited user rights information available";
    if (rights.length <= 2) return `Basic rights available: ${rights.join(', ')}`;
    return `Comprehensive rights provided: ${rights.join(', ')}`;
}
function detectOptOutMethods(text) {
    const methods = [];
    if (text.includes('unsubscribe')) methods.push('email unsubscribe');
    if (text.includes('settings') || text.includes('preferences')) methods.push('account settings');
    if (text.includes('cookie') && text.includes('settings')) methods.push('cookie settings');
    if (text.includes('contact us')) methods.push('contact request');
    return methods;
}
function detectSharingPurposes(text) {
    const purposes = [];
    if (text.includes('service provider')) purposes.push('service provision');
    if (text.includes('advertising') || text.includes('marketing')) purposes.push('advertising');
    if (text.includes('analytics')) purposes.push('analytics');
    if (text.includes('legal') || text.includes('compliance')) purposes.push('legal compliance');
    return purposes;
}
function detectTransferSafeguards(text) {
    const safeguards = [];
    if (text.includes('standard contractual clauses') || text.includes('scc')) safeguards.push('Standard Contractual Clauses');
    if (text.includes('privacy shield')) safeguards.push('Privacy Shield');
    if (text.includes('adequacy decision')) safeguards.push('EU Adequacy Decision');
    if (text.includes('binding corporate rules')) safeguards.push('Binding Corporate Rules');
    return safeguards;
}
function detectContactMethods(text) {
    const methods = [];
    if (text.includes('@')) methods.push('email');
    if (text.includes('phone') || text.includes('call')) methods.push('phone');
    if (text.includes('form') || text.includes('contact form')) methods.push('contact form');
    if (text.includes('mail') && text.includes('address')) methods.push('postal mail');
    return methods;
}
// Original helper functions (enhanced)
function detectDataTypes(text) {
    const types = [];
    if (text.includes('name') || text.includes('email') || text.includes('personal information')) types.push('Personal Identifiers');
    if (text.includes('cooki')) types.push('Cookies & Similar Technologies');
    if (text.includes('location') || text.includes('gps') || text.includes('geolocation')) types.push('Location Data');
    if (text.includes('device') || text.includes('ip') || text.includes('browser')) types.push('Device & Technical Information');
    if (text.includes('usage') || text.includes('analytics') || text.includes('behavior')) types.push('Usage & Activity Data');
    if (text.includes('payment') || text.includes('credit card') || text.includes('financial')) types.push('Financial Information');
    if (text.includes('biometric')) types.push('Biometric Data');
    if (text.includes('health') || text.includes('medical')) types.push('Health Information');
    return types;
}
function detectPurposes(text) {
    const purposes = [];
    if (text.includes('service') || text.includes('provide') || text.includes('operate')) purposes.push('Service Provision');
    if (text.includes('personaliz') || text.includes('custom') || text.includes('tailor')) purposes.push('Personalization');
    if (text.includes('advertis') || text.includes('market') || text.includes('promot')) purposes.push('Advertising & Marketing');
    if (text.includes('analytics') || text.includes('improve') || text.includes('research')) purposes.push('Analytics & Improvement');
    if (text.includes('security') || text.includes('fraud') || text.includes('protect')) purposes.push('Security & Fraud Prevention');
    if (text.includes('legal') || text.includes('comply') || text.includes('regulation')) purposes.push('Legal Compliance');
    if (text.includes('communication') || text.includes('support') || text.includes('respond')) purposes.push('Communication & Support');
    return purposes;
}
function detectTrackingTechnologies(text) {
    const tech = [];
    if (text.includes('cooki')) tech.push('Cookies');
    if (text.includes('pixel') || text.includes('tracking pixel')) tech.push('Tracking Pixels');
    if (text.includes('fingerprint') || text.includes('device fingerprint')) tech.push('Device Fingerprinting');
    if (text.includes('beacon') || text.includes('web beacon')) tech.push('Web Beacons');
    if (text.includes('local storage') || text.includes('session storage')) tech.push('Local Storage');
    if (text.includes('sdk') || text.includes('software development kit')) tech.push('SDKs');
    return tech;
}
function detectSecurityMeasures(text) {
    const measures = [];
    if (text.includes('encrypt')) measures.push('Encryption');
    if (text.includes('ssl') || text.includes('tls')) measures.push('SSL/TLS');
    if (text.includes('firewall')) measures.push('Firewalls');
    if (text.includes('access control') || text.includes('authentication')) measures.push('Access Controls');
    if (text.includes('secure') && text.includes('server')) measures.push('Secure Servers');
    if (text.includes('monitor') || text.includes('security monitoring')) measures.push('Security Monitoring');
    if (text.includes('two-factor') || text.includes('multi-factor')) measures.push('Multi-Factor Authentication');
    if (text.includes('audit') || text.includes('security audit')) measures.push('Security Audits');
    return measures;
}
function detectUpdateMethod(text) {
    if (text.includes('email') && text.includes('notif')) return 'Email Notification';
    if (text.includes('post') || text.includes('website')) return 'Website Posting';
    if (text.includes('in-app') || text.includes('notification')) return 'In-App Notification';
    return 'Not Specified';
}
function detectOtherRegulations(text) {
    const regs = [];
    if (text.includes('hipaa')) regs.push('HIPAA');
    if (text.includes('lgpd')) regs.push('LGPD (Brazil)');
    if (text.includes('pipeda')) regs.push('PIPEDA (Canada)');
    if (text.includes('popia')) regs.push('POPIA (South Africa)');
    if (text.includes('pdpa')) regs.push('PDPA');
    return regs;
}
// Main analysis endpoint
app.post('/api/analyze', async (req, res) => {
    try {
        const { url } = req.body;
       
        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }
        console.log(`\n📊 Analysis Request: ${url}`);
        // Step 1: Extract policy text
        const policyText = await extractPolicyText(url);
       
        // Step 2: Analyze with configured AI provider
        let analysis;
        try {
            if (AI_PROVIDER === 'openai') {
                analysis = await analyzePolicyWithOpenAI(policyText, url);
                analysis.analysis_method = 'openai';
            } else {
                analysis = await analyzePolicyWithMistral(policyText, url);
                analysis.analysis_method = 'mistral_ai';
            }
        } catch (aiError) {
            console.error('⚠️ AI analysis failed, using enhanced fallback:', aiError.message);
            analysis = performRuleBasedAnalysis(policyText, url);
            analysis.ai_error = aiError.message;
        }
        // Step 3: Return results
        console.log(`✓ Analysis complete for ${url}\n`);
       
        res.json({
            success: true,
            url: url,
            analysis: analysis,
            text_length: policyText.length,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('✗ Analysis error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});
// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        service: 'PolAI Backend v2.1',
        ai_provider: AI_PROVIDER,
        mistral_configured: !!MISTRAL_API_KEY,
        openai_configured: !!OPENAI_API_KEY,
        endpoints: {
            analyze_url: '/api/analyze',
            analyze_text: '/api/analyze-text',
            batch_analyze: '/api/analyze/batch',
            scan_app: '/api/scan-app'
        },
        timestamp: new Date().toISOString()
    });
});
// Batch analysis endpoint
app.post('/api/analyze/batch', async (req, res) => {
    try {
        const { urls } = req.body;
       
        if (!urls || !Array.isArray(urls)) {
            return res.status(400).json({ error: 'URLs array is required' });
        }
        if (urls.length > 10) {
            return res.status(400).json({ error: 'Maximum 10 URLs allowed per batch' });
        }
        console.log(`\n📊 Batch Analysis: ${urls.length} URLs`);
        const results = [];
       
        for (const url of urls) {
            try {
                const policyText = await extractPolicyText(url);
                let analysis;
               
                try {
                    if (AI_PROVIDER === 'openai') {
                        analysis = await analyzePolicyWithOpenAI(policyText, url);
                        analysis.analysis_method = 'openai';
                    } else {
                        analysis = await analyzePolicyWithMistral(policyText, url);
                        analysis.analysis_method = 'mistral_ai';
                    }
                } catch (aiError) {
                    analysis = performRuleBasedAnalysis(policyText, url);
                    analysis.ai_error = aiError.message;
                }
               
                results.push({
                    url,
                    success: true,
                    analysis,
                    text_length: policyText.length
                });
               
            } catch (error) {
                results.push({
                    url,
                    success: false,
                    error: error.message
                });
            }
           
            // Add delay between requests
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        console.log(`✓ Batch analysis complete\n`);
        res.json({
            success: true,
            results,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('✗ Batch analysis error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Text analysis endpoint (for OCR results)
app.post('/api/analyze-text', async (req, res) => {
    try {
        const { text } = req.body;
       
        if (!text || text.trim().length < 50) {
            return res.status(400).json({ 
                success: false,
                error: 'Text too short. Please provide at least 50 characters of policy text.' 
            });
        }

        console.log(`\n📄 Text Analysis Request: ${text.length} characters`);

        // Analyze the text directly
        let analysis;
        try {
            if (AI_PROVIDER === 'openai') {
                analysis = await analyzePolicyWithOpenAI(text, 'Direct Text Input');
                analysis.analysis_method = 'openai';
            } else {
                analysis = await analyzePolicyWithMistral(text, 'Direct Text Input');
                analysis.analysis_method = 'mistral_ai';
            }
        } catch (aiError) {
            console.error('⚠️ AI analysis failed, using enhanced fallback:', aiError.message);
            analysis = performRuleBasedAnalysis(text, 'Direct Text Input');
            analysis.ai_error = aiError.message;
        }

        console.log(`✓ Text analysis complete\n`);
       
        res.json({
            success: true,
            source: 'text',
            analysis: analysis,
            text_length: text.length,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('✗ Text analysis error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// App scanning endpoint (for background task)
app.post('/api/scan-app', async (req, res) => {
    try {
        const { packageName, policyUrl } = req.body;
       
        if (!packageName && !policyUrl) {
            return res.status(400).json({ 
                success: false,
                error: 'Package name or policy URL required' 
            });
        }

        console.log(`\n📱 App Scan Request: ${packageName || 'Unknown'}`);

        let url = policyUrl;

        // If no URL provided, try to find it
        if (!url && packageName) {
            url = await findAppPrivacyPolicy(packageName);
            
            if (!url) {
                return res.status(404).json({
                    success: false,
                    error: 'Could not find privacy policy for this app',
                    packageName
                });
            }
        }

        // Extract and analyze policy
        const policyText = await extractPolicyText(url);
        let analysis;
       
        try {
            if (AI_PROVIDER === 'openai') {
                analysis = await analyzePolicyWithOpenAI(policyText, url);
                analysis.analysis_method = 'openai';
            } else {
                analysis = await analyzePolicyWithMistral(policyText, url);
                analysis.analysis_method = 'mistral_ai';
            }
        } catch (aiError) {
            analysis = performRuleBasedAnalysis(policyText, url);
            analysis.ai_error = aiError.message;
        }

        // Calculate simple score
        const score = calculateSimpleScore(analysis);

        console.log(`✓ App scan complete - Score: ${score}/100\n`);
       
        res.json({
            success: true,
            packageName,
            url,
            score,
            analysis,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('✗ App scan error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Helper: Find app privacy policy
async function findAppPrivacyPolicy(packageName) {
    try {
        // Try Play Store
        const playStoreUrl = `https://play.google.com/store/apps/details?id=${packageName}`;
        const response = await axios.get(playStoreUrl, {
            headers: getHeaders(playStoreUrl),
            timeout: 10000
        });

        const $ = cheerio.load(response.data);
        
        // Look for privacy policy link
        const privacyLink = $('a[href*="privacy"]').first().attr('href') ||
                          $('a[href*="policy"]').first().attr('href');

        if (privacyLink) {
            return privacyLink.startsWith('http') ? privacyLink : `https://play.google.com${privacyLink}`;
        }

        // Try common URLs
        const domain = packageName.split('.').slice(-2).join('.');
        const commonUrls = [
            `https://${domain}/privacy`,
            `https://${domain}/privacy-policy`,
            `https://www.${domain}/privacy`
        ];

        for (const url of commonUrls) {
            try {
                await axios.head(url, { timeout: 3000 });
                return url;
            } catch (e) {
                continue;
            }
        }

        return null;
    } catch (error) {
        console.error('Error finding privacy policy:', error.message);
        return null;
    }
}

// Helper: Calculate simple score
function calculateSimpleScore(analysis) {
    let score = 100;
    
    if (analysis.data_sharing?.third_parties) {
        score -= analysis.data_sharing.user_control ? 15 : 25;
    }
    
    if (!analysis.user_rights?.deletion) score -= 20;
    if (!analysis.user_rights?.access) score -= 10;
    if (!analysis.user_rights?.opt_out) score -= 10;
    
    if (analysis.cookies_tracking?.cookies_used && !analysis.cookies_tracking?.opt_out_available) {
        score -= 15;
    }
    
    if (!analysis.security_measures?.encryption_mentioned) score -= 10;
    
    if (!analysis.compliance?.gdpr_mentioned && !analysis.compliance?.ccpa_mentioned) {
        score -= 10;
    }
    
    return Math.max(0, score);
}

// Start server
app.listen(PORT, () => {
    console.log('\n╔════════════════════════════════════════╗');
    console.log('║ PolAI Backend v2.0 - Enhanced ║');
    console.log('╚════════════════════════════════════════╝');
    console.log(`\n🚀 Server running: http://localhost:${PORT}`);
    console.log(`🤖 AI Provider: ${AI_PROVIDER.toUpperCase()}`);
    console.log(`🔍 Health check: http://localhost:${PORT}/api/health`);
    console.log(`📊 Analyze endpoint: POST http://localhost:${PORT}/api/analyze`);
   
    if (!MISTRAL_API_KEY && AI_PROVIDER === 'mistral') {
        console.warn('\n⚠️ WARNING: MISTRAL_API_KEY not set!');
    }
    if (!OPENAI_API_KEY && AI_PROVIDER === 'openai') {
        console.warn('\n⚠️ WARNING: OPENAI_API_KEY not set!');
    }
   
    console.log('\n✓ Ready to analyze privacy policies\n');
});
module.exports = app;