'use strict';

const express = require('express');
const line = require('@line/bot-sdk');
const firebase = require('firebase-admin');
const { Client } = require("@googlemaps/google-maps-services-js");
const dialogflow = require('@google-cloud/dialogflow');
const { v4: uuidv4 } = require('uuid');
const { GoogleGenerativeAI } = require("@google/generative-ai"); 

require('dotenv').config();

// ----- 1. INITIALIZE SERVICES -----
const config = {
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.Client(config);

const serviceAccount = require('./serviceAccountKey.json');
if (firebase.apps.length === 0) {
    firebase.initializeApp({
        credential: firebase.credential.cert(serviceAccount)
    });
}
const db = firebase.firestore();

const googleMapsClient = new Client({});

const DIALOGFLOW_PROJECT_ID = 'linebot-mrt';
const DIALOGFLOW_KEY_FILE = './dialogflow-key.json';
const sessionClient = new dialogflow.SessionsClient({
    keyFilename: DIALOGFLOW_KEY_FILE
});
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });


const app = express();
app.use(express.static('public'));


// ----- 2. DATA & HELPER FUNCTIONS -----
const MRT_BLUE_LINE_STATIONS = {
    "สามย่าน": {"lat": 13.732952, "lng": 100.529431},
    "สีลม": {"lat": 13.729908, "lng": 100.535898},
    "ลุมพินี": {"lat": 13.729172, "lng": 100.546305},
    "คลองเตย": {"lat": 13.723912, "lng": 100.556276},
    "ศูนย์การประชุมแห่งชาติสิริกิติ์": {"lat": 13.722881, "lng": 100.561587},
    "สุขุมวิท": {"lat": 13.738012, "lng": 100.561081},
    "เพชรบุรี": {"lat": 13.750873, "lng": 100.561919},
    "พระราม 9": {"lat": 13.758031, "lng": 100.565439},
    "ศูนย์วัฒนธรรมแห่งประเทศไทย": {"lat": 13.765664, "lng": 100.569106},
    "ห้วยขวาง": {"lat": 13.778844, "lng": 100.574633},
    "สุทธิสาร": {"lat": 13.789233, "lng": 100.574784},
    "รัชดาภิเษก": {"lat": 13.797274, "lng": 100.575647},
    "ลาดพร้าว": {"lat": 13.806659, "lng": 100.576899},
    "พหลโยธิน": {"lat": 13.815779, "lng": 100.562144},
    "สวนจตุจักร": {"lat": 13.822295, "lng": 100.552278},
    "กำแพงเพชร": {"lat": 13.824706, "lng": 100.548481},
    "บางซื่อ": {"lat": 13.803362, "lng": 100.535032},
    "เตาปูน": {"lat": 13.806306, "lng": 100.529450}, 
    "บางโพ": {"lat": 13.811808, "lng": 100.521833},
    "บางอ้อ": {"lat": 13.805565, "lng": 100.512686},
    "บางพลัด": {"lat": 13.790588, "lng": 100.506541},
    "สิรินธร": {"lat": 13.782017, "lng": 100.493922},
    "บางยี่ขัน": {"lat": 13.771146, "lng": 100.488390},
    "บางขุนนนท์": {"lat": 13.764491, "lng": 100.477085},
    "ไฟฉาย": {"lat": 13.757352, "lng": 100.469033},
    "จรัญฯ 13": {"lat": 13.751325, "lng": 100.470724},
    "ท่าพระ": {"lat": 13.743015, "lng": 100.472280}, 
    "บางไผ่": {"lat": 13.734685, "lng": 100.468841},
    "บางหว้า": {"lat": 13.723824, "lng": 100.460144}, 
    "เพชรเกษม 48": {"lat": 13.722686, "lng": 100.444747},
    "ภาษีเจริญ": {"lat": 13.719601, "lng": 100.434440},
    "บางแค": {"lat": 13.715367, "lng": 100.418041},
    "หลักสอง": {"lat": 13.710784, "lng": 100.406103},
    "วัดมังกร": {"lat": 13.743734, "lng": 100.509747},
    "สามยอด": {"lat": 13.747199, "lng": 100.503276},
    "สนามไชย": {"lat": 13.743384, "lng": 100.495048},
    "อิสรภาพ": {"lat": 13.747444, "lng": 100.485233},
    };

async function detectIntent(userId, text) {
    const sessionId = uuidv4();
    const sessionPath = sessionClient.projectAgentSessionPath(DIALOGFLOW_PROJECT_ID, sessionId);
    const request = {
        session: sessionPath,
        queryInput: { text: { text: text, languageCode: 'th-TH' } },
    };
    try {
        console.log(`Sending to Dialogflow: "${text}"`);
        const responses = await sessionClient.detectIntent(request);
        return responses[0].queryResult;
    } catch (error) {
        console.error('ERROR DETECTING INTENT:', error);
        return null;
    }
}

async function searchGooglePlaces(apiKey, keyword, lat, lng) {
    console.log(`Searching Google (TextSearch) for: ${keyword}`);
    try {
        const response = await googleMapsClient.textSearch({
            params: {
                query: keyword,
                location: { lat, lng },
                radius: 1500,
                language: 'th',
                key: apiKey,
            },
            timeout: 5000,
        });
        console.log('Successfully got response from Google API.');
        return response.data.results || [];
    } catch (e) {
        console.error("Google Maps API (TextSearch) Error:", e.response ? e.response.data : e.message);
        return [];
    }
}

function createShopCarousel(places, apiKey, hasNextPage) {
    if (!places || places.length === 0) {
        return { type: 'text', text: 'ขออภัย ไม่พบร้านค้าที่ตรงกับเงื่อนไขของคุณในขณะนี้' };
    }

    const bubbles = places.map(place => {
        if (!place || !place.place_id) {
            return null;
        }

        const placeId = place.place_id;
        const name = place.name;
        const address = place.vicinity || 'ไม่ระบุที่อยู่';
        const rating = place.rating ? `⭐ ${place.rating.toFixed(1)}` : 'ไม่มีคะแนน';
        let imageUrl = "https://storage.googleapis.com/proudcity/mebanenc/uploads/2021/03/placeholder-image.png";
        
        if (place.photos && place.photos.length > 0) {
            const photoReference = place.photos[0].photo_reference;
            imageUrl = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=400&photoreference=${photoReference}&key=${apiKey}`;
        }
        const gmapsUrl = `https://www.google.com/maps/search/?api=1&query=Google&query_place_id=${placeId}`;

        return {
            type: 'bubble',
            hero: { type: 'image', url: imageUrl, size: 'full', aspectRatio: '20:13', aspectMode: 'cover' },
            body: {
                type: 'box', layout: 'vertical',
                contents: [
                    { type: 'text', text: name, weight: 'bold', size: 'xl', wrap: true },
                    { type: 'box', layout: 'baseline', margin: 'md', contents: [{ type: 'text', text: rating, size: 'sm', color: '#999999', flex: 0 }] },
                    { type: 'text', text: address, wrap: true, size: 'sm', color: '#666666', margin: 'md' }
                ]
            },
            // --- VVVVVV START: ส่วน Footer ที่ปรับปรุงสี VVVVVV ---
            footer: {
                type: 'box',
                layout: 'vertical',
                spacing: 'md',
                contents: [
                    // <<< ปุ่ม "ดูบนแผนที่" แบบมีสี >>>
                    {
                        type: 'box',
                        layout: 'horizontal',
                        backgroundColor: '#dfeeffff', // สีน้ำเงิน
                        cornerRadius: 'md',
                        paddingAll: 'md',
                        justifyContent: 'center',
                        action: {
                            type: 'uri',
                            label: 'ดูบนแผนที่',
                            uri: gmapsUrl
                        },
                        contents: [
                            { type: 'text', text: 'ดูบนแผนที่', color: '#FFFFFF', weight: 'bold', size: 'sm' }
                        ]
                    },
                    { type: 'box', layout: 'horizontal', spacing: 'sm',
                        contents: [
                            // <<< ปุ่ม "ร้านโปรด" >>>
                            { 
                                type: 'box', layout: 'horizontal', cornerRadius: 'md', 
                                backgroundColor: '#ff9fb5ff', // สีชมพูอ่อน
                                paddingAll: 'md', justifyContent: 'center', alignItems: 'center', flex: 1,
                                action: { type: 'postback', label: 'add_favorite', data: `action=add_favorite&shop_id=${placeId}` },
                                contents: [ { type: 'text', text: '💓', color: '#C71585', weight: 'bold', size: 'sm', align: 'center' } ]
                            },
                            // <<< ปุ่ม "ดูภายหลัง" >>>
                            { 
                                type: 'box', layout: 'horizontal', cornerRadius: 'md', 
                                backgroundColor: '#ffd1f8ff', // สีเทาอ่อน
                                paddingAll: 'md', justifyContent: 'center', alignItems: 'center', flex: 1,
                                action: { type: 'postback', label: 'add_watch_later', data: `action=add_watch_later&shop_id=${placeId}` },
                                contents: [ { type: 'text', text: 'ดูภายหลัง', color: '#333333', weight: 'bold', size: 'sm', align: 'center' } ]
                            }
                        ]
                    }
                ]
            }
        };
    }).filter(bubble => bubble !== null);

    if (bubbles.length === 0) {
        return { type: 'text', text: 'ขออภัย มีข้อผิดพลาดในการแสดงผลข้อมูลร้านค้า' };
    }

     if (hasNextPage) {
        // <<< ปุ่ม "แสดงเพิ่มเติม" แบบมีสี >>>
        const loadMoreBubble = {
            type: 'bubble',
            body: { 
                type: 'box', layout: 'vertical', justifyContent: 'center', alignItems: 'center', paddingAll: 'xl',
                backgroundColor: '#ffffffff', 
                action: { type: 'postback', label: 'แสดงเพิ่มเติม', data: 'action=next_page' },
                contents: [ { type: 'text', text: 'แสดงเพิ่มเติม', color: '#575757ff', weight: 'bold' } ]
            }
        };
        bubbles.push(loadMoreBubble);
    }

    return { type: 'flex', altText: 'ผลการค้นหาร้านค้า', contents: { type: 'carousel', contents: bubbles } };
};

async function callGemini(prompt) {
    try {
        console.log(`Sending to Gemini: "${prompt}"`);
        const result = await geminiModel.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        console.log('Got response from Gemini.');
        return text;
    } catch (error) {
        console.error('ERROR CALLING GEMINI API:', error);

        // --- VVVVVV START: ส่วนที่เพิ่มเข้ามา VVVVVV ---
        // ตรวจสอบว่าเป็น Error ประเภท "Service Unavailable" หรือไม่
        if (error.status === 503) {
            return "ตอนนี้มีผู้ใช้งานพร้อมกันจำนวนมาก ทำให้ฉันตอบกลับช้ากว่าปกติ กรุณาลองใหม่อีกครั้งในสักครู่นะ";
        }
        // ตรวจสอบว่าเป็น Error ประเภท "Not Found" (เผื่อไว้ในอนาคต)
        if (error.status === 404) {
            return "ขออภัย ตอนนี้ฉันไม่สามารถเชื่อมต่อกับระบบ AI ได้ กรุณาแจ้งผู้ดูแล";
        }
        // --- ^^^^^^ END: ส่วนที่เพิ่มเข้ามา ^^^^^^ ---

        // ตอบข้อความกลางๆ สำหรับ Error ประเภทอื่นๆ ที่เราไม่รู้จัก
        return "ขออภัย ตอนนี้ฉันอาจจะยังไม่ค่อยเข้าใจ ลองถามคำถามอื่นได้ไหมคะ";
    }
}

// ----- 3. WEBHOOK ENDPOINT -----
app.get('/callback', (req, res) => { res.status(200).send('OK'); });

app.post('/callback', line.middleware(config), (req, res) => {
    Promise
        .all(req.body.events.map(handleEvent))
        .then((result) => res.json(result))
        .catch((err) => { console.error(err); res.status(500).end(); });
});

// ----- 4. EVENT HANDLER -----
const handleEvent = async (event) => {
    const userId = event.source.userId;

    if (event.type === 'follow') {
        try {
            const profile = await client.getProfile(userId);
            const userRef = db.collection('users').doc(userId);
            await userRef.set({
                line_userId: userId,
                displayName: profile.displayName,
                pictureUrl: profile.pictureUrl,
                statusMessage: profile.statusMessage || null,
                followedAt: new Date()
            }, { merge: true });

            console.log(`User ${profile.displayName} has followed the bot and profile is saved.`);

            return client.replyMessage(event.replyToken, {
                type: 'text',
                text: `สวัสดีคุณ ${profile.displayName}! ขอบคุณที่เพิ่มเพื่อน ยินดีให้บริการ`
            });
            
        } catch (error) {
            console.error('Error handling follow event:', error);
            return Promise.resolve(null);
        }
    }

    if (event.type === 'postback') {
        const data = event.postback.data;
        const params = new URLSearchParams(data);
        const action = params.get('action');
        
        if (action === 'add_favorite' || action === 'add_watch_later') {
            const shopId = params.get('shop_id');
            const collectionName = action === 'add_favorite' ? 'favorites' : 'watch_later';
            const replyText = action === 'add_favorite' ? 'บันทึกร้านนี้เป็นร้านโปรดของคุณเรียบร้อยแล้ว' : 'บันทึกร้านนี้ไว้ดูภายหลังเรียบร้อยแล้ว';
            
            const docRef = db.collection('users').doc(userId).collection(collectionName).doc(shopId);
            await docRef.set({ addedAt: new Date() });
            return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
        } 
        else if (action === 'next_page') {
            const userStateRef = db.collection('users').doc(userId);
            const userDoc = await userStateRef.get();
            
            if (!userDoc.exists || !userDoc.data().currentSearch) {
                return client.replyMessage(event.replyToken, { type: 'text', text: 'ขออภัย ไม่พบข้อมูลการค้นหาล่าสุดของคุณ กรุณาค้นหาใหม่' });
            }

            const currentSearch = userDoc.data().currentSearch;
            const currentPage = currentSearch.currentPage || 1;
            const startIndex = currentPage * 5;
            
            if (startIndex >= currentSearch.placeIds.length) {
                 return client.replyMessage(event.replyToken, { type: 'text', text: 'นี่คือผลการค้นหาสุดท้ายแล้ว' });
            }
            
            const nextPlaceIds = currentSearch.placeIds.slice(startIndex, startIndex + 5);

            if (nextPlaceIds.length === 0) {
                return client.replyMessage(event.replyToken, { type: 'text', text: 'นี่คือผลการค้นหาสุดท้ายแล้ว' });
            }

            const shopPromises = nextPlaceIds.map(id => db.collection('shops').doc(id).get());
            const shopDocs = await Promise.all(shopPromises);
            const placesToShow = shopDocs
                .filter(doc => doc.exists)
                .map(doc => doc.data());

            const hasNextPage = currentSearch.placeIds.length > startIndex + 5;
            const replyMessageObject = createShopCarousel(placesToShow, process.env.GOOGLE_API_KEY, hasNextPage);

            await userStateRef.update({ 'currentSearch.currentPage': currentPage + 1 });
            return client.replyMessage(event.replyToken, replyMessageObject);
        }
    }

    if (event.type !== 'message' || event.message.type !== 'text') {
        return Promise.resolve(null);
    }
    
    const textFromUser = event.message.text.trim();
    const dfResult = await detectIntent(userId, textFromUser);

    if (!dfResult || !dfResult.intent) {
        console.log("Could not detect intent. Calling Gemini as fallback.");
        const geminiResponse = await callGemini(textFromUser);
        return client.replyMessage(event.replyToken, { type: 'text', text: geminiResponse });
    }

    const intentName = dfResult.intent.displayName;
    console.log(`Detected Intent: ${intentName}`);

    if (intentName === 'FindPlaces') {
        const params = dfResult.parameters.fields;
        const cuisine = params.cuisine ? params.cuisine.stringValue : 'ร้านอาหาร';
        const station = params.mrt_station ? params.mrt_station.stringValue : '';

        if (dfResult.fulfillmentText && !dfResult.allRequiredParamsPresent) {
            return client.replyMessage(event.replyToken, { type: 'text', text: dfResult.fulfillmentText });
        }
        
        if (station && MRT_BLUE_LINE_STATIONS[station]) {
            const stationInfo = MRT_BLUE_LINE_STATIONS[station];
            const fullSearchQuery = `${cuisine} ${station}`;
            const allPlaces = await searchGooglePlaces(process.env.GOOGLE_API_KEY, fullSearchQuery, stationInfo.lat, stationInfo.lng);
            
            if (allPlaces && allPlaces.length > 0) {
                const batch = db.batch();
                allPlaces.forEach(place => {
                    const shopRef = db.collection('shops').doc(place.place_id);
                    batch.set(shopRef, {
                        place_id: place.place_id,
                        name: place.name || 'ไม่มีชื่อ',
                        vicinity: place.vicinity || 'ไม่ระบุที่อยู่',
                        rating: place.rating || null,
                        photos: place.photos || null
                    }, { merge: true });
                });
                await batch.commit();

                const placeIds = allPlaces.map(place => place.place_id);
                const userStateRef = db.collection('users').doc(userId);
                await userStateRef.set({
                    currentSearch: {
                        query: fullSearchQuery,
                        placeIds: placeIds,
                        currentPage: 1
                    }
                }, { merge: true });
                console.log(`Cached/Updated ${allPlaces.length} shops and user state.`);
            }
            
            const placesToShow = allPlaces.slice(0, 5);
            const hasNextPage = allPlaces.length > 5;
            const replyMessageObject = createShopCarousel(placesToShow, process.env.GOOGLE_API_KEY, hasNextPage);
            
            return client.replyMessage(event.replyToken, replyMessageObject);

        } else {
             return client.replyMessage(event.replyToken, { type: 'text', text: `ขออภัย ไม่พบข้อมูลของสถานี ${station || 'ที่คุณระบุ'}` });
        }
    } 
    else if (intentName === 'Default Fallback Intent') {
        const geminiResponse = await callGemini(dfResult.queryText);
        return client.replyMessage(event.replyToken, { type: 'text', text: geminiResponse });
    }
    else if (dfResult.fulfillmentText) {
        return client.replyMessage(event.replyToken, { type: 'text', text: dfResult.fulfillmentText });
    } 
    else {
        console.log("Unhandled case. Calling Gemini as final fallback.");
        const geminiResponse = await callGemini(dfResult.queryText);
        return client.replyMessage(event.replyToken, { type: 'text', text: geminiResponse });
    }
};

// ----- 5. START SERVER -----
const port = process.env.PORT || 10000;
app.listen(port, '0.0.0.0', () => {
    console.log(`listening on ${port}`);
});