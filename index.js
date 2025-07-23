'use strict';

const express = require('express');
const line = require('@line/bot-sdk');
const firebase = require('firebase-admin');
const { Client } = require("@googlemaps/google-maps-services-js");
const dialogflow = require('@google-cloud/dialogflow');
const { v4: uuidv4 } = require('uuid');

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

const DIALOGFLOW_PROJECT_ID = 'linebot-mrt'; // <<< สำคัญ: แก้เป็น Project ID ของคุณ
const DIALOGFLOW_KEY_FILE = './dialogflow-key.json';
const sessionClient = new dialogflow.SessionsClient({
    keyFilename: DIALOGFLOW_KEY_FILE
});

const app = express();
app.use(express.static('public'));


// ----- 2. DATA & HELPER FUNCTIONS -----
const MRT_BLUE_LINE_STATIONS = {
    // ... (ใส่รายชื่อสถานี MRT ทั้งหมดของคุณที่นี่) ...
    "หัวลำโพง": { lat: 13.739186, lng: 100.516893 },
    "สามย่าน": { lat: 13.732952, lng: 100.529431 },
    "สีลม": { lat: 13.729908, lng: 100.535898 },
    "สุขุมวิท": { lat: 13.738012, lng: 100.561081 },
    "บางซื่อ": { lat: 13.803362, lng: 100.535032 },
    "พระราม 9": { lat: 13.758031, lng: 100.565439 },
    "ศูนย์วัฒนธรรมแห่งประเทศไทย": { lat: 13.765664, lng: 100.569106 },
    // เพิ่มให้ครบ...
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
        return { type: 'text', text: 'ขออภัยค่ะ ไม่พบร้านค้าที่ตรงกับเงื่อนไขของคุณในขณะนี้' };
    }

    const bubbles = places.map(place => {
        const placeId = place.place_id;
        const name = place.name;
        const address = place.vicinity || 'ไม่ระบุที่อยู่';
        const rating = place.rating ? `⭐ ${place.rating.toFixed(1)}` : 'ไม่มีคะแนน';
        let imageUrl = "https://www. மேல்-level-seo.com/wp-content/uploads/2019/08/no-image-found.png";
        
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
            footer: {
                type: 'box', layout: 'vertical', spacing: 'sm',
                contents: [
                    { type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label: 'ดูบนแผนที่', uri: gmapsUrl } },
                    { type: 'button', style: 'primary', color: '#FF6B6B', height: 'sm', action: { type: 'postback', label: '❤️ เพิ่มเป็นร้านโปรด', data: `action=add_favorite&shop_id=${placeId}` } },
                    { type: 'button', style: 'secondary', color: '#BDBDBD', height: 'sm', action: { type: 'postback', label: '🔖 บันทึกไวดูภายหลัง', data: `action=add_watch_later&shop_id=${placeId}` } },
                ]
            }
        };
    });

    if (hasNextPage) {
        const loadMoreBubble = {
            type: 'bubble',
            body: {
                type: 'box',
                layout: 'vertical',
                spacing: 'sm',
                contents: [
                    { type: 'button', flex: 1, gravity: 'center',
                      action: { type: 'postback', label: 'แสดงเพิ่มเติม ➡️', data: 'action=next_page' } }
                ]
            }
        };
        bubbles.push(loadMoreBubble);
    }

    return {
        type: 'flex',
        altText: 'ผลการค้นหาร้านค้า',
        contents: { type: 'carousel', contents: bubbles }
    };
};

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

    if (event.type === 'postback') {
        const data = event.postback.data;
        const params = new URLSearchParams(data);
        const action = params.get('action');
        
        if (action === 'add_favorite' || action === 'add_watch_later') {
            const shopId = params.get('shop_id');
            const collectionName = action === 'add_favorite' ? 'favorites' : 'watch_later';
            const replyText = action === 'add_favorite' ? 'บันทึกร้านนี้เป็นร้านโปรดของคุณเรียบร้อยแล้ว! ❤️' : 'บันทึกร้านนี้ไว้ดูภายหลังเรียบร้อยแล้วครับ 🔖';
            
            const docRef = db.collection('users').doc(userId).collection(collectionName).doc(shopId);
            await docRef.set({ addedAt: new Date() });
            return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
        } 
        
        // --- **เพิ่ม Logic นี้เข้าไป** ---
        else if (action === 'next_page') {
            const userStateRef = db.collection('users').doc(userId);
            const userDoc = await userStateRef.get();
            const currentSearch = userDoc.data().currentSearch;

            if (!currentSearch || !currentSearch.placeIds) {
                return client.replyMessage(event.replyToken, { type: 'text', text: 'ขออภัยค่ะ ไม่พบข้อมูลการค้นหาล่าสุดของคุณ กรุณาค้นหาใหม่ค่ะ' });
            }

            const currentPage = currentSearch.currentPage;
            const nextPage = currentPage + 1;
            const startIndex = currentPage * 5;
            
            const nextPlaceIds = currentSearch.placeIds.slice(startIndex, startIndex + 5);

            if (nextPlaceIds.length === 0) {
                return client.replyMessage(event.replyToken, { type: 'text', text: 'นี่คือผลการค้นหาสุดท้ายแล้วค่ะ' });
            }

            const shopPromises = nextPlaceIds.map(id => db.collection('shops').doc(id).get());
            const shopDocs = await Promise.all(shopPromises);
            const placesToShow = shopDocs.filter(doc => doc.exists).map(doc => ({ place_id: doc.id, ...doc.data() }));

            const hasNextPage = currentSearch.placeIds.length > startIndex + 5;
            const replyMessageObject = createShopCarousel(placesToShow, process.env.GOOGLE_API_KEY, hasNextPage);

            await userStateRef.update({ 'currentSearch.currentPage': nextPage });

            return client.replyMessage(event.replyToken, replyMessageObject);
        }
    }

    if (event.type !== 'message' || event.message.type !== 'text') {
        return Promise.resolve(null);
    }
    
    const textFromUser = event.message.text.trim();
    const dfResult = await detectIntent(userId, textFromUser);

    if (dfResult && dfResult.intent && dfResult.intent.displayName === 'FindPlaces') {
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
                        name: place.name,
                        address: place.vicinity || 'ไม่ระบุที่อยู่',
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
             return client.replyMessage(event.replyToken, { type: 'text', text: `ขออภัยค่ะ ไม่พบข้อมูลของสถานี ${station || 'ที่คุณระบุ'}` });
        }
    }
    
    if (dfResult && dfResult.fulfillmentText) {
        return client.replyMessage(event.replyToken, { type: 'text', text: dfResult.fulfillmentText });
    } else {
        return client.replyMessage(event.replyToken, { type: 'text', text: "ขออภัยค่ะ ฉันไม่เข้าใจจริงๆ ลองใหม่อีกครั้งนะคะ" });
    }
};

// ----- 5. START SERVER -----
const port = process.env.PORT || 10000;
app.listen(port, '0.0.0.0', () => {
    console.log(`listening on ${port}`);
});