'use strict';

const express = require('express');
const line = require('@line/bot-sdk');
const firebase = require('firebase-admin');
const { Client } = require("@googlemaps/google-maps-services-js");

require('dotenv').config();

// ----- LINE -----
const config = {
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.Client(config);

// ----- Firebase -----
const serviceAccount = require('./serviceAccountKey.json');
if (firebase.apps.length === 0) {
    firebase.initializeApp({
        credential: firebase.credential.cert(serviceAccount)
    });
}
const db = firebase.firestore();

// ----- Google Maps -----
const googleMapsClient = new Client({});

// ----- Express App -----
const app = express();
app.use(express.static('public')); // สำหรับเสิร์ฟไฟล์หน้า LIFF

const MRT_BLUE_LINE_STATIONS = {
    // ... (ใส่รายชื่อสถานี MRT ทั้งหมดของคุณที่นี่) ...
    "หัวลำโพง": { lat: 13.739186, lng: 100.516893 },
    "สามย่าน": { lat: 13.732952, lng: 100.529431 },
    "สีลม": { lat: 13.729908, lng: 100.535898 },
    "สุขุมวิท": { lat: 13.738012, lng: 100.561081 },
    "บางซื่อ": { lat: 13.803362, lng: 100.535032 },
};

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
        const results = response.data.results;
        return results; // คืนค่าทั้งหมดที่ได้มา (สูงสุด 20)

    } catch (e) {
        console.error("Google Maps API (TextSearch) Error:", e.response ? e.response.data : e.message);
        return [];
    }
}

function createShopCarousel(places, apiKey) {
    if (!places || places.length === 0) {
        return { type: 'text', text: 'ขออภัยครับ ไม่พบร้านค้าที่ตรงกับเงื่อนไขของคุณ' };
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
                    {
                        type: 'box', layout: 'baseline', margin: 'md',
                        contents: [ { type: 'text', text: rating, size: 'sm', color: '#999999', flex: 0 } ]
                    },
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

// Endpoint สำหรับ LINE Webhook Verification
app.get('/callback', (req, res) => {
    res.status(200).send('OK');
});

app.post('/callback', line.middleware(config), (req, res) => {
    Promise
        .all(req.body.events.map(handleEvent))
        .then((result) => res.json(result))
        .catch((err) => {
            console.error(err);
            res.status(500).end();
        });
});

const handleEvent = async (event) => {
    // --- จัดการ Postback Event (กดปุ่ม) ---
    if (event.type === 'postback') {
        // (ส่วนนี้เราจะมาเพิ่ม action=next_page ในอนาคต)
        const data = event.postback.data;
        const params = new URLSearchParams(data);
        const action = params.get('action');
        const shopId = params.get('shop_id');
        const userId = event.source.userId;

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

    // --- จัดการ Message Event (ส่งข้อความ) ---
    if (event.type !== 'message' || event.message.type !== 'text') {
        return Promise.resolve(null);
    }

    const textFromUser = event.message.text.trim();
    let foundStation = null;
    let keyword = textFromUser;

    for (const stationName in MRT_BLUE_LINE_STATIONS) {
        if (textFromUser.includes(stationName)) {
            foundStation = stationName;
            keyword = keyword.replace(stationName, '').trim();
            break;
        }
    }

    if (foundStation) {
        const stationInfo = MRT_BLUE_LINE_STATIONS[foundStation];
        
        const allPlaces = await searchGooglePlaces(process.env.GOOGLE_API_KEY, `${keyword} ${foundStation}`, stationInfo.lat, stationInfo.lng);

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

        // แสดงผลแค่ 5 ร้านแรกก่อน
        const placesToShow = allPlaces.slice(0, 5);
        const replyMessageObject = createShopCarousel(placesToShow, process.env.GOOGLE_API_KEY);
        return client.replyMessage(event.replyToken, replyMessageObject);

    } else {
        return client.replyMessage(event.replyToken, {
            type: 'text',
            text: "ขออภัยครับ ไม่พบชื่อสถานี MRT สายสีน้ำเงินในข้อความของคุณ ลองพิมพ์เช่น 'คาเฟ่ สนามไชย' หรือ 'ร้านอาหารญี่ปุ่น สุขุมวิท' ครับ"
        });
    }
};

const port = process.env.PORT || 10000;
app.listen(port, '0.0.0.0', () => {
    console.log(`listening on ${port}`);
});