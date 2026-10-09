// ==UserScript==
// @name         Google Voice AI Inspection Scheduler (Ollama + iCal + Telegram + NIIS Sync)
// @namespace    https://github.com/midsummerred32/gv-ai-scheduler
// @version      2.0.0
// @downloadURL  https://raw.githubusercontent.com/midsummerred32/gv-ai-scheduler/refs/heads/main/google_voice_ai_scheduler_userscript.js
// @updateURL    https://raw.githubusercontent.com/midsummerred32/gv-ai-scheduler/refs/heads/main/google_voice_ai_scheduler_userscript.js
// @description  Automates inspection scheduling in Google Voice using Ollama, live iCal feeds, Telegram approval, and automatically marks contact/appointment status in the National (NIIS) portal.
// @author       midsummerred32
// @match        https://voice.google.com/*
// @match        https://*.nationalis.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @connect      localhost
// @connect      127.0.0.1
// @connect      calendar.google.com
// @connect      api.telegram.org
// @connect      nationalis.com
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const IS_GOOGLE_VOICE = window.location.hostname.includes('voice.google.com');
    const IS_NATIONAL_PORTAL = window.location.hostname.includes('nationalis.com');

    // =========================================================================
    // CONFIGURATION & DEFAULTS
    // =========================================================================
    const CONFIG = {
        ollamaUrl: GM_getValue('ollamaUrl', 'http://localhost:11434/api/generate'),
        ollamaModel: GM_getValue('ollamaModel', 'llama3.2:latest'),
        icalUrl: GM_getValue('icalUrl', ''),
        telegramToken: GM_getValue('telegramToken', ''),
        telegramChatId: GM_getValue('telegramChatId', ''),
        autoLogNational: GM_getValue('autoLogNational', true),
        inspectionDurationHours: 3,
        workdayStartHour: 9,
        workdayEndHour: 17,
    };

    // Menu commands (accessible in Tampermonkey toolbar icon)
    GM_registerMenuCommand('Configure Google Calendar iCal URL', () => {
        const val = prompt('Paste your Google Calendar Secret iCal Address:', CONFIG.icalUrl);
        if (val !== null) {
            GM_setValue('icalUrl', val.trim());
            CONFIG.icalUrl = val.trim();
            alert('Calendar URL saved.');
        }
    });

    GM_registerMenuCommand('Configure Telegram Credentials', () => {
        const token = prompt('Enter Telegram Bot Token:', CONFIG.telegramToken);
        const chatId = prompt('Enter your Telegram Chat ID:', CONFIG.telegramChatId);
        if (token !== null && chatId !== null) {
            GM_setValue('telegramToken', token.trim());
            GM_setValue('telegramChatId', chatId.trim());
            CONFIG.telegramToken = token.trim();
            CONFIG.telegramChatId = chatId.trim();
            alert('Telegram credentials saved.');
        }
    });

    GM_registerMenuCommand('Configure Ollama Settings', () => {
        const url = prompt('Enter Ollama Endpoint:', CONFIG.ollamaUrl);
        const model = prompt('Enter Ollama Model Name:', CONFIG.ollamaModel);
        if (url !== null && model !== null) {
            GM_setValue('ollamaUrl', url.trim());
            GM_setValue('ollamaModel', model.trim());
            CONFIG.ollamaUrl = url.trim();
            CONFIG.ollamaModel = model.trim();
            alert('Ollama settings saved.');
        }
    });

    GM_registerMenuCommand('Toggle National (NIIS) Auto-Sync', () => {
        const current = GM_getValue('autoLogNational', true);
        GM_setValue('autoLogNational', !current);
        alert(`National portal auto-sync is now: ${!current ? 'ENABLED' : 'DISABLED'}`);
    });

    // =========================================================================
    // CROSS-TAB EVENT BUS: SYNC TO NATIONAL (NIIS) PORTAL
    // =========================================================================
    /**
     * Broadcasts an action from Google Voice to any open National portal tab
     * using Tampermonkey's synchronized storage event bus.
     */
    function broadcastToNational(payload) {
        if (!GM_getValue('autoLogNational', true)) return;
        
        const syncEvent = {
            id: Date.now() + '_' + Math.random().toString(36).substr(2, 5),
            timestamp: new Date().toISOString(),
            ...payload
        };
        GM_setValue('latest_national_sync_event', syncEvent);
        console.log('[GV-AI -> NIIS] Broadcasted sync event:', syncEvent);
    }

    // =========================================================================
    // PART A: NATIONAL (NIIS) PORTAL DOM AUTOMATION
    // (Executes when the tab is on nationalis.com)
    // =========================================================================
    if (IS_NATIONAL_PORTAL) {
        console.log('[GV-AI] National (NIIS) portal tab active and listening for sync events.');

        // Listen for actions emitted by Google Voice
        GM_addValueChangeListener('latest_national_sync_event', (name, oldValue, newValue) => {
            if (!newValue || !newValue.action) return;
            handleNationalSyncRequest(newValue);
        });

        async function handleNationalSyncRequest(event) {
            console.log('[NIIS] Received sync command:', event);

            const phoneDigits = event.phone ? event.phone.replace(/\D/g, '').slice(-10) : '';

            // Check if current page matches this order or phone number
            const pageText = document.body.innerText;
            const matchesCurrentOrder = phoneDigits && pageText.includes(phoneDigits);

            if (event.action === 'SMS_SENT') {
                logMessageSentInNational(event, matchesCurrentOrder);
            } else if (event.action === 'APPOINTMENT_SCHEDULED') {
                logAppointmentScheduledInNational(event, matchesCurrentOrder);
            }
        }

        function logMessageSentInNational(event, isMatchingPage) {
            try {
                // 1. Locate contact/communication logging buttons or checkboxes
                const smsCheckbox = document.querySelector('input[type="checkbox"][id*="sms" i], input[type="checkbox"][name*="sms" i], input[value*="SMS" i]');
                const contactStatusSelect = document.querySelector('select[name*="contact" i], select[id*="contact" i], select[name*="status" i]');
                const notesField = document.querySelector('textarea[name*="note" i], textarea[id*="note" i], textarea[name*="comment" i]');

                if (smsCheckbox && !smsCheckbox.checked) {
                    smsCheckbox.checked = true;
                    smsCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
                }

                if (contactStatusSelect) {
                    // Try to match "First Contact - SMS", "SMS Sent", or "Contacted"
                    for (let opt of contactStatusSelect.options) {
                        if (/sms|text|message sent/i.test(opt.text)) {
                            contactStatusSelect.value = opt.value;
                            contactStatusSelect.dispatchEvent(new Event('change', { bubbles: true }));
                            break;
                        }
                    }
                }

                if (notesField && event.draftText) {
                    const timestampStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    const entry = `[${timestampStr}] AI SMS sent to client: "${event.draftText.slice(0, 120)}..."`;
                    notesField.value = notesField.value ? `${notesField.value}\n${entry}` : entry;
                    notesField.dispatchEvent(new Event('input', { bubbles: true }));
                }

                // Look for common save buttons
                triggerNationalSaveButton();

                console.log('[NIIS] Marked SMS Sent successfully.');
            } catch (err) {
                console.error('[NIIS] Error logging SMS Sent in portal:', err);
            }
        }

        function logAppointmentScheduledInNational(event, isMatchingPage) {
            try {
                // 1. Set appointment date/time fields if present
                const dateInput = document.querySelector('input[name*="appoint" i], input[id*="appoint" i], input[name*="sched" i]');
                const statusSelect = document.querySelector('select[name*="status" i], select[id*="status" i], select[name*="order_status" i]');

                if (statusSelect) {
                    for (let opt of statusSelect.options) {
                        if (/scheduled|appointment set/i.test(opt.text)) {
                            statusSelect.value = opt.value;
                            statusSelect.dispatchEvent(new Event('change', { bubbles: true }));
                            break;
                        }
                    }
                }

                if (dateInput && event.scheduledTime) {
                    dateInput.value = event.scheduledTime;
                    dateInput.dispatchEvent(new Event('input', { bubbles: true }));
                    dateInput.dispatchEvent(new Event('change', { bubbles: true }));
                }

                triggerNationalSaveButton();
                console.log('[NIIS] Marked Appointment Scheduled successfully.');
            } catch (err) {
                console.error('[NIIS] Error logging appointment in portal:', err);
            }
        }

        function triggerNationalSaveButton() {
            const saveBtn = document.querySelector('button[type="submit"], input[type="submit"], button[id*="save" i], button[name*="save" i], .btn-save');
            if (saveBtn) {
                setTimeout(() => {
                    saveBtn.click();
                    console.log('[NIIS] Auto-saved portal form.');
                }, 800);
            }
        }

        // Return early on National portal page; rest of script runs on Google Voice
        return;
    }

    // =========================================================================
    // PART B: GOOGLE CALENDAR (iCal) PARSER
    // =========================================================================
    function parseICalDate(dateStr) {
        if (!dateStr) return null;
        const clean = dateStr.trim();
        if (clean.length === 8) {
            const y = parseInt(clean.substring(0, 4), 10);
            const m = parseInt(clean.substring(4, 6), 10) - 1;
            const d = parseInt(clean.substring(6, 8), 10);
            return new Date(y, m, d, 0, 0, 0);
        }

        const match = clean.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?/);
        if (match) {
            const [, y, m, d, h, min, s, isUtc] = match;
            if (isUtc) {
                return new Date(Date.UTC(+y, +m - 1, +d, +h, +min, +s));
            }
            return new Date(+y, +m - 1, +d, +h, +min, +s);
        }
        return new Date(clean);
    }

    function fetchBusyEvents() {
        return new Promise((resolve, reject) => {
            if (!CONFIG.icalUrl) {
                return resolve([]);
            }

            GM_xmlhttpRequest({
                method: 'GET',
                url: CONFIG.icalUrl,
                headers: { 'Cache-Control': 'no-cache' },
                onload: (res) => {
                    if (res.status !== 200) {
                        return reject(new Error(`Failed to load calendar: HTTP ${res.status}`));
                    }
                    const raw = res.responseText;
                    const eventMatches = [...raw.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g)];
                    const busyRanges = [];

                    eventMatches.forEach((m) => {
                        const block = m[1];
                        const dtStartMatch = block.match(/DTSTART(?:;[^:]+)?:([^\r\n]+)/);
                        const dtEndMatch = block.match(/DTEND(?:;[^:]+)?:([^\r\n]+)/);

                        if (dtStartMatch) {
                            const start = parseICalDate(dtStartMatch[1]);
                            const end = dtEndMatch ? parseICalDate(dtEndMatch[1]) : new Date(start.getTime() + 3600000);
                            if (start && end && !isNaN(start.getTime()) && !isNaN(end.getTime())) {
                                busyRanges.push({ start, end });
                            }
                        }
                    });

                    resolve(busyRanges);
                },
                onerror: (err) => reject(err)
            });
        });
    }

    async function getAvailableInspectionSlots() {
        try {
            const busyList = await fetchBusyEvents();
            const candidateSlots = [];
            const now = new Date();
            let checkDate = new Date(now);
            checkDate.setDate(checkDate.getDate() + 1);

            while (candidateSlots.length < 3 && candidateSlots.length < 5) {
                const dayOfWeek = checkDate.getDay();
                if (dayOfWeek !== 0 && dayOfWeek !== 6) {
                    const morningSlotStart = new Date(checkDate.getFullYear(), checkDate.getMonth(), checkDate.getDate(), 9, 0, 0);
                    const morningSlotEnd = new Date(morningSlotStart.getTime() + (CONFIG.inspectionDurationHours * 3600000));

                    const afternoonSlotStart = new Date(checkDate.getFullYear(), checkDate.getMonth(), checkDate.getDate(), 13, 30, 0);
                    const afternoonSlotEnd = new Date(afternoonSlotStart.getTime() + (CONFIG.inspectionDurationHours * 3600000));

                    const isMorningBusy = busyList.some(ev => (morningSlotStart < ev.end && morningSlotEnd > ev.start));
                    const isAfternoonBusy = busyList.some(ev => (afternoonSlotStart < ev.end && afternoonSlotEnd > ev.start));

                    const options = { weekday: 'long', month: 'short', day: 'numeric' };
                    const dayLabel = checkDate.toLocaleDateString('en-US', options);

                    if (!isMorningBusy && candidateSlots.length < 3) {
                        candidateSlots.push(`${dayLabel} at 9:00 AM`);
                    }
                    if (!isAfternoonBusy && candidateSlots.length < 3) {
                        candidateSlots.push(`${dayLabel} at 1:30 PM`);
                    }
                }
                checkDate.setDate(checkDate.getDate() + 1);
            }

            return candidateSlots.length > 0 
                ? candidateSlots.join(', or ')
                : 'Monday at 9:00 AM or Tuesday at 1:30 PM';
        } catch (e) {
            console.error('[GV-AI] Error calculating open slots:', e);
            return 'Monday at 9:00 AM or Tuesday at 1:30 PM';
        }
    }

    // =========================================================================
    // PART C: OLLAMA LOCAL AI GENERATION
    // =========================================================================
    function generateAIReply(clientMessage, slots) {
        return new Promise((resolve, reject) => {
            const prompt = `You are a professional home inspection scheduling assistant.
A client sent this message: "${clientMessage}".
Our current confirmed inspection openings are: ${slots}.

Rules:
1. Suggest 2 of the confirmed openings politely.
2. Keep the response to 1-2 friendly, concise sentences suitable for SMS.
3. Ask the client if either time works for their inspection or if they need another window.
4. Output ONLY the response message text. No quotes, intro, or sign-offs.`;

            GM_xmlhttpRequest({
                method: 'POST',
                url: CONFIG.ollamaUrl,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({
                    model: CONFIG.ollamaModel,
                    prompt: prompt,
                    stream: false
                }),
                onload: (res) => {
                    try {
                        const json = JSON.parse(res.responseText);
                        resolve(json.response.trim());
                    } catch (e) {
                        reject(new Error('Failed to parse Ollama response: ' + res.responseText));
                    }
                },
                onerror: (err) => reject(err)
            });
        });
    }

    // =========================================================================
    // PART D: TELEGRAM BOT CLIENT (APPROVAL FLOW)
    // =========================================================================
    function sendTelegramApprovalRequest(clientName, clientPhone, clientText, draftedReply, callbackId) {
        return new Promise((resolve, reject) => {
            if (!CONFIG.telegramToken || !CONFIG.telegramChatId) {
                return reject(new Error('Telegram Bot Token or Chat ID not configured.'));
            }

            const text = `🏡 *New Inspection Inquiry*\n\n` +
                         `*Client:* ${clientName} (${clientPhone})\n` +
                         `*Message:* _${clientText}_\n\n` +
                         `🤖 *AI Drafted Reply:*\n\`${draftedReply}\`\n\n` +
                         `_Approving will send SMS and mark 'Message Sent' in National._`;

            const inlineKeyboard = {
                inline_keyboard: [
                    [
                        { text: '✅ Approve & Send SMS', callback_data: `send_${callbackId}` },
                        { text: '❌ Reject Draft', callback_data: `reject_${callbackId}` }
                    ]
                ]
            };

            GM_xmlhttpRequest({
                method: 'POST',
                url: `https://api.telegram.org/bot${CONFIG.telegramToken}/sendMessage`,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({
                    chat_id: CONFIG.telegramChatId,
                    text: text,
                    parse_mode: 'Markdown',
                    reply_markup: inlineKeyboard
                }),
                onload: (res) => {
                    try {
                        const json = JSON.parse(res.responseText);
                        if (json.ok) resolve(json.result);
                        else reject(new Error(json.description));
                    } catch (e) {
                        reject(e);
                    }
                },
                onerror: reject
            });
        });
    }

    function pollTelegramDecision(callbackId, timeoutMs = 300000) {
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            let lastUpdateId = 0;

            const check = () => {
                if (Date.now() - startTime > timeoutMs) {
                    return resolve('timeout');
                }

                GM_xmlhttpRequest({
                    method: 'GET',
                    url: `https://api.telegram.org/bot${CONFIG.telegramToken}/getUpdates?offset=${lastUpdateId}&timeout=5`,
                    onload: (res) => {
                        try {
                            const json = JSON.parse(res.responseText);
                            if (json.ok && json.result.length > 0) {
                                for (const update of json.result) {
                                    lastUpdateId = update.update_id + 1;
                                    if (update.callback_query && update.callback_query.data) {
                                        const data = update.callback_query.data;
                                        if (data === `send_${callbackId}`) {
                                            acknowledgeTelegramCallback(update.callback_query.id, 'Approved! Sending SMS & updating National...');
                                            return resolve('approved');
                                        }
                                        if (data === `reject_${callbackId}`) {
                                            acknowledgeTelegramCallback(update.callback_query.id, 'Draft cancelled.');
                                            return resolve('rejected');
                                        }
                                    }
                                }
                            }
                        } catch (e) {
                            console.warn('[GV-AI] Polling parse error:', e);
                        }
                        setTimeout(check, 2500);
                    },
                    onerror: () => setTimeout(check, 3500)
                });
            };

            check();
        });
    }

    function acknowledgeTelegramCallback(queryId, text) {
        GM_xmlhttpRequest({
            method: 'POST',
            url: `https://api.telegram.org/bot${CONFIG.telegramToken}/answerCallbackQuery`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ callback_query_id: queryId, text: text })
        });
    }

    // =========================================================================
    // PART E: GOOGLE VOICE DOM EXTRACTION & HUMAN TYPING
    // =========================================================================
    function getMessageInputField() {
        return document.querySelector('textarea[aria-label*="message" i], div[contenteditable="true"][aria-label*="message" i]');
    }

    function getSendButton() {
        return document.querySelector('button[aria-label*="Send message" i], gv-icon-button[aria-label*="Send" i]');
    }

    function getActiveThreadMessages() {
        const bubbles = document.querySelectorAll('gv-text-message-item, div[gv-test-id="item-view"]');
        if (!bubbles || bubbles.length === 0) return [];
        return Array.from(bubbles).map(b => b.innerText.trim()).filter(Boolean);
    }

    function getActiveClientDetails() {
        const headerEl = document.querySelector('header, gv-conversation-header');
        const headerText = headerEl ? headerEl.innerText : '';
        
        // Extract phone number: (XXX) XXX-XXXX or +1XXXXXXXXXX
        const phoneMatch = headerText.match(/\+?1?\s*\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
        const nameMatch = headerEl ? headerEl.querySelector('h1') : null;

        return {
            name: nameMatch ? nameMatch.innerText.trim() : 'Unknown Client',
            phone: phoneMatch ? phoneMatch[0].trim() : 'Unknown Phone'
        };
    }

    async function humanTypeIntoField(field, text) {
        field.focus();
        if (field.tagName.toLowerCase() === 'textarea') {
            field.value = '';
            field.dispatchEvent(new Event('input', { bubbles: true }));
        }

        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            if (field.tagName.toLowerCase() === 'textarea') {
                field.value += char;
                field.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
                document.execCommand('insertText', false, char);
            }

            let delay = Math.floor(Math.random() * (120 - 40 + 1)) + 40;
            if (['.', ',', '!', '?'].includes(char)) delay += 200;
            if (char === ' ') delay += 60;
            await new Promise(r => setTimeout(r, delay));
        }

        field.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // =========================================================================
    // PART F: IN-PAGE FLOATING COPILOT UI
    // =========================================================================
    function injectCopilotWidget() {
        if (document.getElementById('gv-copilot-container')) return;

        const widget = document.createElement('div');
        widget.id = 'gv-copilot-container';
        widget.style.cssText = `
            position: fixed;
            bottom: 24px;
            right: 24px;
            z-index: 10000;
            background: #ffffff;
            border: 1px solid #dadce0;
            border-radius: 12px;
            box-shadow: 0 4px 16px rgba(60,64,67,0.2);
            padding: 14px 18px;
            width: 330px;
            font-family: 'Google Sans', Roboto, sans-serif;
            color: #202124;
        `;

        widget.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                <strong style="font-size:14px; color:#1a73e8; display:flex; align-items:center; gap:6px;">
                    ⚡ AI Scheduling Copilot
                </strong>
                <span id="gv-copilot-status" style="font-size:11px; color:#5f6368;">Ready</span>
            </div>
            <p id="gv-copilot-detail" style="font-size:12px; color:#3c4043; margin:0 0 10px 0; line-height:1.4;">
                Open a thread. Generate replies using live iCal slots & auto-sync to National.
            </p>
            <div style="display:flex; gap:6px; margin-bottom:8px;">
                <button id="gv-btn-draft" style="
                    flex: 1;
                    background: #1a73e8;
                    color: white;
                    border: none;
                    padding: 8px 10px;
                    border-radius: 6px;
                    font-size: 12px;
                    font-weight: 500;
                    cursor: pointer;">
                    Draft
                </button>
                <button id="gv-btn-telegram" style="
                    background: #f1f3f4;
                    color: #1a73e8;
                    border: 1px solid #dadce0;
                    padding: 8px 10px;
                    border-radius: 6px;
                    font-size: 12px;
                    cursor: pointer;" title="Send Draft to Telegram for Remote Approval">
                    📱 Telegram
                </button>
                <button id="gv-btn-sync-national" style="
                    background: #e8f0fe;
                    color: #1967d2;
                    border: 1px solid #d2e3fc;
                    padding: 8px 10px;
                    border-radius: 6px;
                    font-size: 12px;
                    cursor: pointer;" title="Manually Mark Sent / Scheduled in National Portal">
                    🏢 Mark NIIS
                </button>
            </div>
            <div id="gv-copilot-footer" style="font-size:10px; color:#70757a; display:flex; justify-content:space-between;">
                <span>Auto-sync National: <b>${CONFIG.autoLogNational ? 'ON' : 'OFF'}</b></span>
            </div>
        `;

        document.body.appendChild(widget);

        const statusEl = document.getElementById('gv-copilot-status');
        const detailEl = document.getElementById('gv-copilot-detail');
        const draftBtn = document.getElementById('gv-btn-draft');
        const tgBtn = document.getElementById('gv-btn-telegram');
        const niisBtn = document.getElementById('gv-btn-sync-national');

        // Action: Generate Draft directly into Google Voice
        draftBtn.onclick = async () => {
            const inputField = getMessageInputField();
            if (!inputField) {
                alert('Please open an active conversation thread first.');
                return;
            }

            try {
                statusEl.innerText = 'Checking iCal...';
                draftBtn.disabled = true;

                const messages = getActiveThreadMessages();
                const latestMsg = messages.length > 0 ? messages[messages.length - 1] : 'Inquiring about scheduling.';
                
                const slots = await getAvailableInspectionSlots();
                statusEl.innerText = 'Asking Ollama...';

                const reply = await generateAIReply(latestMsg, slots);

                statusEl.innerText = 'Typing draft...';
                await humanTypeIntoField(inputField, reply);

                statusEl.innerText = 'Draft ready';
                detailEl.innerText = `Slots: ${slots}`;
            } catch (err) {
                console.error(err);
                statusEl.innerText = 'Error';
                detailEl.innerText = err.message;
            } finally {
                draftBtn.disabled = false;
            }
        };

        // Action: Telegram Remote Flow
        tgBtn.onclick = async () => {
            const inputField = getMessageInputField();
            if (!inputField) {
                alert('Please open an active conversation thread first.');
                return;
            }

            if (!CONFIG.telegramToken || !CONFIG.telegramChatId) {
                alert('Please set your Telegram Bot Token and Chat ID in Tampermonkey script menu.');
                return;
            }

            try {
                statusEl.innerText = 'Drafting & Notifying...';
                tgBtn.disabled = true;

                const messages = getActiveThreadMessages();
                const latestMsg = messages.length > 0 ? messages[messages.length - 1] : 'Inquiry about inspection.';
                const client = getActiveClientDetails();
                const slots = await getAvailableInspectionSlots();

                const reply = await generateAIReply(latestMsg, slots);
                const callbackId = Date.now().toString(36);

                await sendTelegramApprovalRequest(client.name, client.phone, latestMsg, reply, callbackId);
                statusEl.innerText = 'Waiting Telegram...';
                detailEl.innerText = 'Alert sent to phone. Tap Approve or Reject.';

                const decision = await pollTelegramDecision(callbackId);

                if (decision === 'approved') {
                    statusEl.innerText = 'Approved! Typing...';
                    await humanTypeIntoField(inputField, reply);
                    await new Promise(r => setTimeout(r, 1200));

                    const sendBtn = getSendButton();
                    if (sendBtn) {
                        sendBtn.click();
                        statusEl.innerText = 'Sent ✅';
                        detailEl.innerText = 'Message dispatched & synced to National.';
                    } else {
                        statusEl.innerText = 'Draft placed';
                        detailEl.innerText = 'Click send manually.';
                    }

                    // Auto-broadcast to National (NIIS) Portal tab
                    broadcastToNational({
                        action: 'SMS_SENT',
                        phone: client.phone,
                        clientName: client.name,
                        draftText: reply
                    });
                } else if (decision === 'rejected') {
                    statusEl.innerText = 'Rejected ❌';
                    detailEl.innerText = 'Draft was rejected from Telegram.';
                } else {
                    statusEl.innerText = 'Timed out ⏰';
                    detailEl.innerText = 'No Telegram response received.';
                }
            } catch (err) {
                console.error(err);
                statusEl.innerText = 'Error';
                detailEl.innerText = err.message;
            } finally {
                tgBtn.disabled = false;
            }
        };

        // Action: Manual sync to National (NIIS) portal button
        niisBtn.onclick = () => {
            const client = getActiveClientDetails();
            const actionChoice = confirm(`Mark "SMS Sent" in National for ${client.name} (${client.phone})?\n\nPress OK for SMS Sent, or Cancel to schedule appointment.`);
            
            if (actionChoice) {
                broadcastToNational({
                    action: 'SMS_SENT',
                    phone: client.phone,// ==UserScript==
// @name         Google Voice AI Inspection Scheduler (Ollama + iCal + Telegram + NIIS Sync)
// @namespace    https://github.com/midsummerred32/gv-ai-scheduler
// @version      2.0.0
// @description  Automates inspection scheduling in Google Voice using Ollama, live iCal feeds, Telegram approval, and automatically marks contact/appointment status in the National (NIIS) portal.
// @author       midsummerred32
// @match        https://voice.google.com/*
// @match        https://*.nationalis.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @connect      localhost
// @connect      127.0.0.1
// @connect      calendar.google.com
// @connect      api.telegram.org
// @connect      nationalis.com
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const IS_GOOGLE_VOICE = window.location.hostname.includes('voice.google.com');
    const IS_NATIONAL_PORTAL = window.location.hostname.includes('nationalis.com');

    // =========================================================================
    // CONFIGURATION & DEFAULTS
    // =========================================================================
    const CONFIG = {
        ollamaUrl: GM_getValue('ollamaUrl', 'http://localhost:11434/api/generate'),
        ollamaModel: GM_getValue('ollamaModel', 'llama3.2:latest'),
        icalUrl: GM_getValue('icalUrl', ''),
        telegramToken: GM_getValue('telegramToken', ''),
        telegramChatId: GM_getValue('telegramChatId', ''),
        autoLogNational: GM_getValue('autoLogNational', true),
        inspectionDurationHours: 3,
        workdayStartHour: 9,
        workdayEndHour: 17,
    };

    // Menu commands (accessible in Tampermonkey toolbar icon)
    GM_registerMenuCommand('Configure Google Calendar iCal URL', () => {
        const val = prompt('Paste your Google Calendar Secret iCal Address:', CONFIG.icalUrl);
        if (val !== null) {
            GM_setValue('icalUrl', val.trim());
            CONFIG.icalUrl = val.trim();
            alert('Calendar URL saved.');
        }
    });

    GM_registerMenuCommand('Configure Telegram Credentials', () => {
        const token = prompt('Enter Telegram Bot Token:', CONFIG.telegramToken);
        const chatId = prompt('Enter your Telegram Chat ID:', CONFIG.telegramChatId);
        if (token !== null && chatId !== null) {
            GM_setValue('telegramToken', token.trim());
            GM_setValue('telegramChatId', chatId.trim());
            CONFIG.telegramToken = token.trim();
            CONFIG.telegramChatId = chatId.trim();
            alert('Telegram credentials saved.');
        }
    });

    GM_registerMenuCommand('Configure Ollama Settings', () => {
        const url = prompt('Enter Ollama Endpoint:', CONFIG.ollamaUrl);
        const model = prompt('Enter Ollama Model Name:', CONFIG.ollamaModel);
        if (url !== null && model !== null) {
            GM_setValue('ollamaUrl', url.trim());
            GM_setValue('ollamaModel', model.trim());
            CONFIG.ollamaUrl = url.trim();
            CONFIG.ollamaModel = model.trim();
            alert('Ollama settings saved.');
        }
    });

    GM_registerMenuCommand('Toggle National (NIIS) Auto-Sync', () => {
        const current = GM_getValue('autoLogNational', true);
        GM_setValue('autoLogNational', !current);
        alert(`National portal auto-sync is now: ${!current ? 'ENABLED' : 'DISABLED'}`);
    });

    // =========================================================================
    // CROSS-TAB EVENT BUS: SYNC TO NATIONAL (NIIS) PORTAL
    // =========================================================================
    /**
     * Broadcasts an action from Google Voice to any open National portal tab
     * using Tampermonkey's synchronized storage event bus.
     */
    function broadcastToNational(payload) {
        if (!GM_getValue('autoLogNational', true)) return;
        
        const syncEvent = {
            id: Date.now() + '_' + Math.random().toString(36).substr(2, 5),
            timestamp: new Date().toISOString(),
            ...payload
        };
        GM_setValue('latest_national_sync_event', syncEvent);
        console.log('[GV-AI -> NIIS] Broadcasted sync event:', syncEvent);
    }

    // =========================================================================
    // PART A: NATIONAL (NIIS) PORTAL DOM AUTOMATION
    // (Executes when the tab is on nationalis.com)
    // =========================================================================
    if (IS_NATIONAL_PORTAL) {
        console.log('[GV-AI] National (NIIS) portal tab active and listening for sync events.');

        // Listen for actions emitted by Google Voice
        GM_addValueChangeListener('latest_national_sync_event', (name, oldValue, newValue) => {
            if (!newValue || !newValue.action) return;
            handleNationalSyncRequest(newValue);
        });

        async function handleNationalSyncRequest(event) {
            console.log('[NIIS] Received sync command:', event);

            const phoneDigits = event.phone ? event.phone.replace(/\D/g, '').slice(-10) : '';

            // Check if current page matches this order or phone number
            const pageText = document.body.innerText;
            const matchesCurrentOrder = phoneDigits && pageText.includes(phoneDigits);

            if (event.action === 'SMS_SENT') {
                logMessageSentInNational(event, matchesCurrentOrder);
            } else if (event.action === 'APPOINTMENT_SCHEDULED') {
                logAppointmentScheduledInNational(event, matchesCurrentOrder);
            }
        }

        function logMessageSentInNational(event, isMatchingPage) {
            try {
                // 1. Locate contact/communication logging buttons or checkboxes
                const smsCheckbox = document.querySelector('input[type="checkbox"][id*="sms" i], input[type="checkbox"][name*="sms" i], input[value*="SMS" i]');
                const contactStatusSelect = document.querySelector('select[name*="contact" i], select[id*="contact" i], select[name*="status" i]');
                const notesField = document.querySelector('textarea[name*="note" i], textarea[id*="note" i], textarea[name*="comment" i]');

                if (smsCheckbox && !smsCheckbox.checked) {
                    smsCheckbox.checked = true;
                    smsCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
                }

                if (contactStatusSelect) {
                    // Try to match "First Contact - SMS", "SMS Sent", or "Contacted"
                    for (let opt of contactStatusSelect.options) {
                        if (/sms|text|message sent/i.test(opt.text)) {
                            contactStatusSelect.value = opt.value;
                            contactStatusSelect.dispatchEvent(new Event('change', { bubbles: true }));
                            break;
                        }
                    }
                }

                if (notesField && event.draftText) {
                    const timestampStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    const entry = `[${timestampStr}] AI SMS sent to client: "${event.draftText.slice(0, 120)}..."`;
                    notesField.value = notesField.value ? `${notesField.value}\n${entry}` : entry;
                    notesField.dispatchEvent(new Event('input', { bubbles: true }));
                }

                // Look for common save buttons
                triggerNationalSaveButton();

                console.log('[NIIS] Marked SMS Sent successfully.');
            } catch (err) {
                console.error('[NIIS] Error logging SMS Sent in portal:', err);
            }
        }

        function logAppointmentScheduledInNational(event, isMatchingPage) {
            try {
                // 1. Set appointment date/time fields if present
                const dateInput = document.querySelector('input[name*="appoint" i], input[id*="appoint" i], input[name*="sched" i]');
                const statusSelect = document.querySelector('select[name*="status" i], select[id*="status" i], select[name*="order_status" i]');

                if (statusSelect) {
                    for (let opt of statusSelect.options) {
                        if (/scheduled|appointment set/i.test(opt.text)) {
                            statusSelect.value = opt.value;
                            statusSelect.dispatchEvent(new Event('change', { bubbles: true }));
                            break;
                        }
                    }
                }

                if (dateInput && event.scheduledTime) {
                    dateInput.value = event.scheduledTime;
                    dateInput.dispatchEvent(new Event('input', { bubbles: true }));
                    dateInput.dispatchEvent(new Event('change', { bubbles: true }));
                }

                triggerNationalSaveButton();
                console.log('[NIIS] Marked Appointment Scheduled successfully.');
            } catch (err) {
                console.error('[NIIS] Error logging appointment in portal:', err);
            }
        }

        function triggerNationalSaveButton() {
            const saveBtn = document.querySelector('button[type="submit"], input[type="submit"], button[id*="save" i], button[name*="save" i], .btn-save');
            if (saveBtn) {
                setTimeout(() => {
                    saveBtn.click();
                    console.log('[NIIS] Auto-saved portal form.');
                }, 800);
            }
        }

        // Return early on National portal page; rest of script runs on Google Voice
        return;
    }

    // =========================================================================
    // PART B: GOOGLE CALENDAR (iCal) PARSER
    // =========================================================================
    function parseICalDate(dateStr) {
        if (!dateStr) return null;
        const clean = dateStr.trim();
        if (clean.length === 8) {
            const y = parseInt(clean.substring(0, 4), 10);
            const m = parseInt(clean.substring(4, 6), 10) - 1;
            const d = parseInt(clean.substring(6, 8), 10);
            return new Date(y, m, d, 0, 0, 0);
        }

        const match = clean.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?/);
        if (match) {
            const [, y, m, d, h, min, s, isUtc] = match;
            if (isUtc) {
                return new Date(Date.UTC(+y, +m - 1, +d, +h, +min, +s));
            }
            return new Date(+y, +m - 1, +d, +h, +min, +s);
        }
        return new Date(clean);
    }

    function fetchBusyEvents() {
        return new Promise((resolve, reject) => {
            if (!CONFIG.icalUrl) {
                return resolve([]);
            }

            GM_xmlhttpRequest({
                method: 'GET',
                url: CONFIG.icalUrl,
                headers: { 'Cache-Control': 'no-cache' },
                onload: (res) => {
                    if (res.status !== 200) {
                        return reject(new Error(`Failed to load calendar: HTTP ${res.status}`));
                    }
                    const raw = res.responseText;
                    const eventMatches = [...raw.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g)];
                    const busyRanges = [];

                    eventMatches.forEach((m) => {
                        const block = m[1];
                        const dtStartMatch = block.match(/DTSTART(?:;[^:]+)?:([^\r\n]+)/);
                        const dtEndMatch = block.match(/DTEND(?:;[^:]+)?:([^\r\n]+)/);

                        if (dtStartMatch) {
                            const start = parseICalDate(dtStartMatch[1]);
                            const end = dtEndMatch ? parseICalDate(dtEndMatch[1]) : new Date(start.getTime() + 3600000);
                            if (start && end && !isNaN(start.getTime()) && !isNaN(end.getTime())) {
                                busyRanges.push({ start, end });
                            }
                        }
                    });

                    resolve(busyRanges);
                },
                onerror: (err) => reject(err)
            });
        });
    }

    async function getAvailableInspectionSlots() {
        try {
            const busyList = await fetchBusyEvents();
            const candidateSlots = [];
            const now = new Date();
            let checkDate = new Date(now);
            checkDate.setDate(checkDate.getDate() + 1);

            while (candidateSlots.length < 3 && candidateSlots.length < 5) {
                const dayOfWeek = checkDate.getDay();
                if (dayOfWeek !== 0 && dayOfWeek !== 6) {
                    const morningSlotStart = new Date(checkDate.getFullYear(), checkDate.getMonth(), checkDate.getDate(), 9, 0, 0);
                    const morningSlotEnd = new Date(morningSlotStart.getTime() + (CONFIG.inspectionDurationHours * 3600000));

                    const afternoonSlotStart = new Date(checkDate.getFullYear(), checkDate.getMonth(), checkDate.getDate(), 13, 30, 0);
                    const afternoonSlotEnd = new Date(afternoonSlotStart.getTime() + (CONFIG.inspectionDurationHours * 3600000));

                    const isMorningBusy = busyList.some(ev => (morningSlotStart < ev.end && morningSlotEnd > ev.start));
                    const isAfternoonBusy = busyList.some(ev => (afternoonSlotStart < ev.end && afternoonSlotEnd > ev.start));

                    const options = { weekday: 'long', month: 'short', day: 'numeric' };
                    const dayLabel = checkDate.toLocaleDateString('en-US', options);

                    if (!isMorningBusy && candidateSlots.length < 3) {
                        candidateSlots.push(`${dayLabel} at 9:00 AM`);
                    }
                    if (!isAfternoonBusy && candidateSlots.length < 3) {
                        candidateSlots.push(`${dayLabel} at 1:30 PM`);
                    }
                }
                checkDate.setDate(checkDate.getDate() + 1);
            }

            return candidateSlots.length > 0 
                ? candidateSlots.join(', or ')
                : 'Monday at 9:00 AM or Tuesday at 1:30 PM';
        } catch (e) {
            console.error('[GV-AI] Error calculating open slots:', e);
            return 'Monday at 9:00 AM or Tuesday at 1:30 PM';
        }
    }

    // =========================================================================
    // PART C: OLLAMA LOCAL AI GENERATION
    // =========================================================================
    function generateAIReply(clientMessage, slots) {
        return new Promise((resolve, reject) => {
            const prompt = `You are a professional home inspection scheduling assistant.
A client sent this message: "${clientMessage}".
Our current confirmed inspection openings are: ${slots}.

Rules:
1. Suggest 2 of the confirmed openings politely.
2. Keep the response to 1-2 friendly, concise sentences suitable for SMS.
3. Ask the client if either time works for their inspection or if they need another window.
4. Output ONLY the response message text. No quotes, intro, or sign-offs.`;

            GM_xmlhttpRequest({
                method: 'POST',
                url: CONFIG.ollamaUrl,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({
                    model: CONFIG.ollamaModel,
                    prompt: prompt,
                    stream: false
                }),
                onload: (res) => {
                    try {
                        const json = JSON.parse(res.responseText);
                        resolve(json.response.trim());
                    } catch (e) {
                        reject(new Error('Failed to parse Ollama response: ' + res.responseText));
                    }
                },
                onerror: (err) => reject(err)
            });
        });
    }

    // =========================================================================
    // PART D: TELEGRAM BOT CLIENT (APPROVAL FLOW)
    // =========================================================================
    function sendTelegramApprovalRequest(clientName, clientPhone, clientText, draftedReply, callbackId) {
        return new Promise((resolve, reject) => {
            if (!CONFIG.telegramToken || !CONFIG.telegramChatId) {
                return reject(new Error('Telegram Bot Token or Chat ID not configured.'));
            }

            const text = `🏡 *New Inspection Inquiry*\n\n` +
                         `*Client:* ${clientName} (${clientPhone})\n` +
                         `*Message:* _${clientText}_\n\n` +
                         `🤖 *AI Drafted Reply:*\n\`${draftedReply}\`\n\n` +
                         `_Approving will send SMS and mark 'Message Sent' in National._`;

            const inlineKeyboard = {
                inline_keyboard: [
                    [
                        { text: '✅ Approve & Send SMS', callback_data: `send_${callbackId}` },
                        { text: '❌ Reject Draft', callback_data: `reject_${callbackId}` }
                    ]
                ]
            };

            GM_xmlhttpRequest({
                method: 'POST',
                url: `https://api.telegram.org/bot${CONFIG.telegramToken}/sendMessage`,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({
                    chat_id: CONFIG.telegramChatId,
                    text: text,
                    parse_mode: 'Markdown',
                    reply_markup: inlineKeyboard
                }),
                onload: (res) => {
                    try {
                        const json = JSON.parse(res.responseText);
                        if (json.ok) resolve(json.result);
                        else reject(new Error(json.description));
                    } catch (e) {
                        reject(e);
                    }
                },
                onerror: reject
            });
        });
    }

    function pollTelegramDecision(callbackId, timeoutMs = 300000) {
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            let lastUpdateId = 0;

            const check = () => {
                if (Date.now() - startTime > timeoutMs) {
                    return resolve('timeout');
                }

                GM_xmlhttpRequest({
                    method: 'GET',
                    url: `https://api.telegram.org/bot${CONFIG.telegramToken}/getUpdates?offset=${lastUpdateId}&timeout=5`,
                    onload: (res) => {
                        try {
                            const json = JSON.parse(res.responseText);
                            if (json.ok && json.result.length > 0) {
                                for (const update of json.result) {
                                    lastUpdateId = update.update_id + 1;
                                    if (update.callback_query && update.callback_query.data) {
                                        const data = update.callback_query.data;
                                        if (data === `send_${callbackId}`) {
                                            acknowledgeTelegramCallback(update.callback_query.id, 'Approved! Sending SMS & updating National...');
                                            return resolve('approved');
                                        }
                                        if (data === `reject_${callbackId}`) {
                                            acknowledgeTelegramCallback(update.callback_query.id, 'Draft cancelled.');
                                            return resolve('rejected');
                                        }
                                    }
                                }
                            }
                        } catch (e) {
                            console.warn('[GV-AI] Polling parse error:', e);
                        }
                        setTimeout(check, 2500);
                    },
                    onerror: () => setTimeout(check, 3500)
                });
            };

            check();
        });
    }

    function acknowledgeTelegramCallback(queryId, text) {
        GM_xmlhttpRequest({
            method: 'POST',
            url: `https://api.telegram.org/bot${CONFIG.telegramToken}/answerCallbackQuery`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ callback_query_id: queryId, text: text })
        });
    }

    // =========================================================================
    // PART E: GOOGLE VOICE DOM EXTRACTION & HUMAN TYPING
    // =========================================================================
    function getMessageInputField() {
        return document.querySelector('textarea[aria-label*="message" i], div[contenteditable="true"][aria-label*="message" i]');
    }

    function getSendButton() {
        return document.querySelector('button[aria-label*="Send message" i], gv-icon-button[aria-label*="Send" i]');
    }

    function getActiveThreadMessages() {
        const bubbles = document.querySelectorAll('gv-text-message-item, div[gv-test-id="item-view"]');
        if (!bubbles || bubbles.length === 0) return [];
        return Array.from(bubbles).map(b => b.innerText.trim()).filter(Boolean);
    }

    function getActiveClientDetails() {
        const headerEl = document.querySelector('header, gv-conversation-header');
        const headerText = headerEl ? headerEl.innerText : '';
        
        // Extract phone number: (XXX) XXX-XXXX or +1XXXXXXXXXX
        const phoneMatch = headerText.match(/\+?1?\s*\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
        const nameMatch = headerEl ? headerEl.querySelector('h1') : null;

        return {
            name: nameMatch ? nameMatch.innerText.trim() : 'Unknown Client',
            phone: phoneMatch ? phoneMatch[0].trim() : 'Unknown Phone'
        };
    }

    async function humanTypeIntoField(field, text) {
        field.focus();
        if (field.tagName.toLowerCase() === 'textarea') {
            field.value = '';
            field.dispatchEvent(new Event('input', { bubbles: true }));
        }

        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            if (field.tagName.toLowerCase() === 'textarea') {
                field.value += char;
                field.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
                document.execCommand('insertText', false, char);
            }

            let delay = Math.floor(Math.random() * (120 - 40 + 1)) + 40;
            if (['.', ',', '!', '?'].includes(char)) delay += 200;
            if (char === ' ') delay += 60;
            await new Promise(r => setTimeout(r, delay));
        }

        field.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // =========================================================================
    // PART F: IN-PAGE FLOATING COPILOT UI
    // =========================================================================
    function injectCopilotWidget() {
        if (document.getElementById('gv-copilot-container')) return;

        const widget = document.createElement('div');
        widget.id = 'gv-copilot-container';
        widget.style.cssText = `
            position: fixed;
            bottom: 24px;
            right: 24px;
            z-index: 10000;
            background: #ffffff;
            border: 1px solid #dadce0;
            border-radius: 12px;
            box-shadow: 0 4px 16px rgba(60,64,67,0.2);
            padding: 14px 18px;
            width: 330px;
            font-family: 'Google Sans', Roboto, sans-serif;
            color: #202124;
        `;

        widget.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                <strong style="font-size:14px; color:#1a73e8; display:flex; align-items:center; gap:6px;">
                    ⚡ AI Scheduling Copilot
                </strong>
                <span id="gv-copilot-status" style="font-size:11px; color:#5f6368;">Ready</span>
            </div>
            <p id="gv-copilot-detail" style="font-size:12px; color:#3c4043; margin:0 0 10px 0; line-height:1.4;">
                Open a thread. Generate replies using live iCal slots & auto-sync to National.
            </p>
            <div style="display:flex; gap:6px; margin-bottom:8px;">
                <button id="gv-btn-draft" style="
                    flex: 1;
                    background: #1a73e8;
                    color: white;
                    border: none;
                    padding: 8px 10px;
                    border-radius: 6px;
                    font-size: 12px;
                    font-weight: 500;
                    cursor: pointer;">
                    Draft
                </button>
                <button id="gv-btn-telegram" style="
                    background: #f1f3f4;
                    color: #1a73e8;
                    border: 1px solid #dadce0;
                    padding: 8px 10px;
                    border-radius: 6px;
                    font-size: 12px;
                    cursor: pointer;" title="Send Draft to Telegram for Remote Approval">
                    📱 Telegram
                </button>
                <button id="gv-btn-sync-national" style="
                    background: #e8f0fe;
                    color: #1967d2;
                    border: 1px solid #d2e3fc;
                    padding: 8px 10px;
                    border-radius: 6px;
                    font-size: 12px;
                    cursor: pointer;" title="Manually Mark Sent / Scheduled in National Portal">
                    🏢 Mark NIIS
                </button>
            </div>
            <div id="gv-copilot-footer" style="font-size:10px; color:#70757a; display:flex; justify-content:space-between;">
                <span>Auto-sync National: <b>${CONFIG.autoLogNational ? 'ON' : 'OFF'}</b></span>
            </div>
        `;

        document.body.appendChild(widget);

        const statusEl = document.getElementById('gv-copilot-status');
        const detailEl = document.getElementById('gv-copilot-detail');
        const draftBtn = document.getElementById('gv-btn-draft');
        const tgBtn = document.getElementById('gv-btn-telegram');
        const niisBtn = document.getElementById('gv-btn-sync-national');

        // Action: Generate Draft directly into Google Voice
        draftBtn.onclick = async () => {
            const inputField = getMessageInputField();
            if (!inputField) {
                alert('Please open an active conversation thread first.');
                return;
            }

            try {
                statusEl.innerText = 'Checking iCal...';
                draftBtn.disabled = true;

                const messages = getActiveThreadMessages();
                const latestMsg = messages.length > 0 ? messages[messages.length - 1] : 'Inquiring about scheduling.';
                
                const slots = await getAvailableInspectionSlots();
                statusEl.innerText = 'Asking Ollama...';

                const reply = await generateAIReply(latestMsg, slots);

                statusEl.innerText = 'Typing draft...';
                await humanTypeIntoField(inputField, reply);

                statusEl.innerText = 'Draft ready';
                detailEl.innerText = `Slots: ${slots}`;
            } catch (err) {
                console.error(err);
                statusEl.innerText = 'Error';
                detailEl.innerText = err.message;
            } finally {
                draftBtn.disabled = false;
            }
        };

        // Action: Telegram Remote Flow
        tgBtn.onclick = async () => {
            const inputField = getMessageInputField();
            if (!inputField) {
                alert('Please open an active conversation thread first.');
                return;
            }

            if (!CONFIG.telegramToken || !CONFIG.telegramChatId) {
                alert('Please set your Telegram Bot Token and Chat ID in Tampermonkey script menu.');
                return;
            }

            try {
                statusEl.innerText = 'Drafting & Notifying...';
                tgBtn.disabled = true;

                const messages = getActiveThreadMessages();
                const latestMsg = messages.length > 0 ? messages[messages.length - 1] : 'Inquiry about inspection.';
                const client = getActiveClientDetails();
                const slots = await getAvailableInspectionSlots();

                const reply = await generateAIReply(latestMsg, slots);
                const callbackId = Date.now().toString(36);

                await sendTelegramApprovalRequest(client.name, client.phone, latestMsg, reply, callbackId);
                statusEl.innerText = 'Waiting Telegram...';
                detailEl.innerText = 'Alert sent to phone. Tap Approve or Reject.';

                const decision = await pollTelegramDecision(callbackId);

                if (decision === 'approved') {
                    statusEl.innerText = 'Approved! Typing...';
                    await humanTypeIntoField(inputField, reply);
                    await new Promise(r => setTimeout(r, 1200));

                    const sendBtn = getSendButton();
                    if (sendBtn) {
                        sendBtn.click();
                        statusEl.innerText = 'Sent ✅';
                        detailEl.innerText = 'Message dispatched & synced to National.';
                    } else {
                        statusEl.innerText = 'Draft placed';
                        detailEl.innerText = 'Click send manually.';
                    }

                    // Auto-broadcast to National (NIIS) Portal tab
                    broadcastToNational({
                        action: 'SMS_SENT',
                        phone: client.phone,
                        clientName: client.name,
                        draftText: reply
                    });
                } else if (decision === 'rejected') {
                    statusEl.innerText = 'Rejected ❌';
                    detailEl.innerText = 'Draft was rejected from Telegram.';
                } else {
                    statusEl.innerText = 'Timed out ⏰';
                    detailEl.innerText = 'No Telegram response received.';
                }
            } catch (err) {
                console.error(err);
                statusEl.innerText = 'Error';
                detailEl.innerText = err.message;
            } finally {
                tgBtn.disabled = false;
            }
        };

        // Action: Manual sync to National (NIIS) portal button
        niisBtn.onclick = () => {
            const client = getActiveClientDetails();
            const actionChoice = confirm(`Mark "SMS Sent" in National for ${client.name} (${client.phone})?\n\nPress OK for SMS Sent, or Cancel to schedule appointment.`);
            
            if (actionChoice) {
                broadcastToNational({
                    action: 'SMS_SENT',
                    phone: client.phone,
                    clientName: client.name,
                    draftText: 'Manual sync from Google Voice'
                });
                alert(`Broadcasted "SMS Sent" to open National portal tabs for ${client.phone}`);
            } else {
                const schedTime = prompt('Enter appointment date/time for National portal (e.g., 2026-10-15 09:00):');
                if (schedTime) {
                    broadcastToNational({
                        action: 'APPOINTMENT_SCHEDULED',
                        phone: client.phone,
                        clientName: client.name,
                        scheduledTime: schedTime
                    });
                    alert(`Broadcasted "Appointment Scheduled" to National portal.`);
                }
            }
        };ftText: 'Manual sync from Google Voice'
                });
                alert(`Broadcasted "SMS Sent" to open National portal tabs for ${client.phone}`);
            } else {
                const schedTime = prompt('Enter appointment date/time for National portal (e.g., 2026-10-15 09:00):');
                if (schedTime) {
                    broadcastToNational({
                        action: 'APPOINTMENT_SCHEDULED',
                        phone: client.phone,
                        clientName: client.name,
                        scheduledTime: schedTime
                    });
                    alert(`Broadcasted "Appointment Scheduled" to National portal.`);
                }
            }
        };
    }

    // Initialize UI after DOM loads
    const initInterval = setInterval(() => {
        if (document.body) {
            injectCopilotWidget();
            clearInterval(initInterval);
        }
    }, 1500);

})();
                  
    }

    // Initialize UI after DOM loads
    const initInterval = setInterval(() => {
        if (document.body) {
            injectCopilotWidget();
            clearInterval(initInterval);
        }
    }, 1500);

})();
                    clientName: client.name,
                    draftText: 'Manual sync from Google Voice'
                });
                alert(`Broadcasted "SMS Sent" to open National portal tabs for ${client.phone}`);
            } else {
                const schedTime = prompt('Enter appointment date/time for National portal (e.g., 2026-10-15 09:00):');
                if (schedTime) {
                    broadcastToNational({
                        action: 'APPOINTMENT_SCHEDULED',
                        phone: client.phone,
                        clientName: client.name,
                        scheduledTime: schedTime
                    });
                    alert(`Broadcasted "Appointment Scheduled" to National portal.`);
                }
            }
        };
    }

    // Initialize UI after DOM loads
    const initInterval = setInterval(() => {
        if (document.body) {
            injectCopilotWidget();
            clearInterval(initInterval);
        }
    }, 1500);

})();