const axios = require('axios');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const path = require('path');
// const log = require('tracer').colorConsole({ level: 'debug' });


const getFileData = (filePath) => ({
    path: filePath,
    name: path.basename(filePath),
    size: fs.statSync(filePath).size,
    data: fs.createReadStream(filePath),
});

const getCookieStr = (cookies) => {
    let cookieStr = '';

    let googleCookies = cookies.filter(cookie => {
        if (cookie.domain === '.google.com') {
            if (cookie.name === 'SID' || cookie.name === 'SSID' || cookie.name === 'HSID') {
                return cookie;
            }
        }
    });

    for (let i = 0; i < googleCookies.length; i++) {
        cookieStr += googleCookies[i].name + '=' + googleCookies[i].value + '; '
    }
    return cookieStr;
}


module.exports = class Doubleclick {

    constructor (options = {
        chromeExecutable: '',
        cookies: []
    }) {
        this.cookies = options.cookies;
        this.dcUrl = 'https://www.google.com/doubleclick/studio/';
        this.dcApiUrl = 'https://www.google.com/doubleclick/studio/service';
        this.dcUploadUrl = 'https://www.google.com/doubleclick/studio/upload-http';
        this.accountId = '33345';
        this.chromeExecutable = options.chromeExecutable;
        // this.proxy = { // for testing with Charles
        //     host: 'localhost',
        //     port: 8888
        // }
    }

    async login(options = {}) {

        console.log(this.chromeExecutable);
        const browser = await puppeteer.launch({
            headless: false,
            executablePath: this.chromeExecutable
        });
        const page = await browser.newPage();
        await page.goto('https://accounts.google.com/');
        await browser.waitForTarget((target) => target.url().indexOf('https://myaccount.google.com/') === 0, {
            timeout: 0,
        });
        const client = await page.target().createCDPSession();
        const { cookies } = await client.send('Network.getAllCookies');
        await browser.close();

        return cookies;
    }

    async getAdvertiser(advertiserName) {
        return await this.findEntity({
            "service": "AdvertiserService",
            "method": "search",
            "arguments": [
                "{\"names\":[\"" + advertiserName + "\"]}"
            ]
        })
    }

    async getCampaign(advertiser, campaignName) {
        return await this.findEntity({
            "service":"CampaignService",
            "method":"search",
            "arguments": [
                "{\"advertiserId\":" + advertiser.id + ",\"names\":[\"" + campaignName + "\"]}"
            ]
        })
    }

    async getCreative(campaign, creativeName) {
        return await this.findEntity({
            "service":"CreativeService",
            "method":"search",
            "arguments": [
                "{\"accountId\":" + campaign.account.id + ",\"advertiserId\":" + campaign.advertiser.id + ",\"campaignId\":" + campaign.id + ",\"names\":[\"" + creativeName + "\"]}"
            ]
        })
    }

    async createAdvertiser(advertiserName) {
        return await this.findEntity({
            "service":"AdvertiserService",
            "method":"create",
            "arguments": ["{\"accountId\":" + this.accountId + ",\"name\":\"" + advertiserName + "\",\"emailParams\":{\"to\":[],\"cc\":[],\"message\":\"\"}}"]
        })
    }

    async createCampaign(advertiser, campaignName) {
        return await this.findEntity({
            "service":"CampaignService",
            "method":"create",
            "arguments": ["{\"advertiserId\":" + advertiser.id + ",\"name\":\"" + campaignName + "\"}"]
        })
    }

    async createCreative(campaign, creative) {

        return await this.findEntity({
            "service":"CreativeService",
            "method":"insert",
            "arguments": [
              "{\"accountRef\":{\"id\":" + campaign.account.id + "},\"advertiserRef\":{\"id\":" + campaign.advertiser.id + "},\"campaignRef\":{\"id\":" + campaign.id + "},\"format\":\"" + creative.format + "\",\"dimension\":{\"width\":" + creative.width + ",\"height\":" + creative.height + "},\"name\":\"" + creative.name + "\"}"
            ]
        })
    }

    async uploadCreative(creative) {
        const file = getFileData(creative.path);

        const data = {
            "TYPE":"CREATIVE",
            "ACCOUNT_ID":creative.account.id,
            "ADVERTISER_ID":creative.advertiser.id,
            "CREATIVE_ID":creative.id
        };

        let headers = {
            Cookie: getCookieStr(this.cookies),
            'x-goog-upload-file-name': file.name,
            'x-goog-upload-header-content-length': file.size,
            'x-goog-upload-protocol': 'resumable',
            'x-goog-upload-command': 'start',
            'x-goog-upload-offset': '0',
        }

        const result = await axios.post( this.dcUploadUrl, data, {
            headers,
            proxy: this.proxy || ''
        });

        const params = {
            'upload_id': result.headers['x-guploader-uploadid'],
            'upload_protocol': 'resumable'
        }

        // now upload file
        headers['x-goog-upload-command'] = 'upload, finalize';

        return await axios.post( this.dcUploadUrl, file.data, {
            headers,
            params,
            proxy: this.proxy || ''
        });
    }

    async getPreviewUrl(campaign) {
        return await this.findEntity({
            "service":"ExternalPreviewService",
            "method":"getSummariesForCampaign",
            "arguments": [
                "\"" + campaign.advertiser.id + "\"",
                "\"" + campaign.id + "\""
            ]
        })
    }

    async getXsrfToken() {
        if (this.cachedXsrfToken) {
            return this.cachedXsrfToken;
        }

        let headers = {
            Cookie: getCookieStr(this.cookies),
        }

        const result = await axios.get(this.dcUrl, {
            headers,
            proxy: this.proxy || ''
        });

        const startPos = result.data.indexOf('xsrfToken') + 12;
        const endPos = result.data.indexOf('\",', startPos);
        const xsrfTokenString = result.data.substr(startPos, endPos-startPos);

        this.cachedXsrfToken = xsrfTokenString; //store as var for future usage
        return xsrfTokenString;
    }

    async findEntity(data) {
        const xsrfToken = await this.getXsrfToken();

        let headers = {
            Cookie: getCookieStr(this.cookies),
            "x-xsrf-token": xsrfToken
        }

        return await axios.post(this.dcApiUrl, data, {
            headers,
            proxy: this.proxy || ''
        });
    }
}