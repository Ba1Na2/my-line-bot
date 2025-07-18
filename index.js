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
     "หัวลำโพง": {"lat": 13.739186, "lng": 100.516893},
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

function createShopCarousel(places, apiKey) {
    if (!places || places.length === 0) {
        return { type: 'text', text: 'ขออภัยค่ะ ไม่พบร้านค้าที่ตรงกับเงื่อนไขของคุณในขณะนี้' };
    }

    // จำกัดผลลัพธ์ที่จะแสดงใน Carousel ไม่ให้เกิน 10 การ์ด (ตามข้อกำหนดของ LINE)
    const placesToShow = places.slice(0, 10);

    const bubbles = placesToShow.map(place => {
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
        const shopId = params.get('shop_id');

        if (action === 'add_favorite') {
            const favoriteRef = db.collection('users').doc(userId).collection('favorites').doc(shopId);
            await favoriteRef.set({ addedAt: new Date() });
            return client.replyMessage(event.replyToken, { type: 'text', text: 'บันทึกร้านนี้เป็นร้านโปรดของคุณเรียบร้อยแล้ว! ❤️' });
        } 
        else if (action === 'add_watch_later') {
            const watchLaterRef = db.collection('users').doc(userId).collection('watch_later').doc(shopId);
            await watchLaterRef.set({ addedAt: new Date() });
            return client.replyMessage(event.replyToken, { type: 'text', text: 'บันทึกร้านนี้ไว้ดูภายหลังเรียบร้อยแล้วครับ 🔖' });
        }
    }

    if (event.type !== 'message' || event.message.type !== 'text') {
        return Promise.resolve(null);
    }
    
    const textFromUser = event.message.text.trim();
    const dfResult = await detectIntent(userId, textFromUser);

    if (dfResult && dfResult.intent) {
        console.log(`Intent detected: ${dfResult.intent.displayName}`);
        const intentName = dfResult.intent.displayName;
        const params = dfResult.parameters.fields;

        if (intentName === 'FindPlaces') {
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
                    console.log(`Cached/Updated ${allPlaces.length} shops to Firestore.`);
                }
                
                const replyMessageObject = createShopCarousel(allPlaces, process.env.GOOGLE_API_KEY);
                return client.replyMessage(event.replyToken, replyMessageObject);
            } else {
                 return client.replyMessage(event.replyToken, { type: 'text', text: `ขออภัยค่ะ ไม่พบข้อมูลของสถานี ${station || 'ที่คุณระบุ'}` });
            }
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