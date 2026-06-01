const ADULT_KEYWORDS = [
    '黄色', '成人', '福利', '无码', '有码', '国产自拍', '麻豆', '91', 'av', '自拍偷拍'
];

const ANIME_KEYWORDS = [
    '动漫', '番', 'anime'
];

function createJsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body, null, 2), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': '*',
            'Cache-Control': 'no-store'
        }
    });
}

function normalizeGithubUrl(rawUrl) {
    if (!rawUrl) {
        return rawUrl;
    }

    if (rawUrl.startsWith('https://gh-proxy.org/http://') || rawUrl.startsWith('https://gh-proxy.org/https://')) {
        return normalizeGithubUrl(rawUrl.replace('https://gh-proxy.org/', ''));
    }

    try {
        const parsedUrl = new URL(rawUrl);
        if (parsedUrl.hostname === 'github.com') {
            const parts = parsedUrl.pathname.split('/').filter(Boolean);
            const blobIndex = parts.indexOf('blob');
            if (parts.length >= 5 && blobIndex === 2) {
                const owner = parts[0];
                const repo = parts[1];
                const branch = parts[3];
                const filePath = parts.slice(4).join('/');
                return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
            }
        }
    } catch (_) {
        return rawUrl;
    }

    return rawUrl;
}

function isAdultName(name = '') {
    const lowered = name.toLowerCase();
    return ADULT_KEYWORDS.some(keyword => lowered.includes(keyword.toLowerCase()));
}

function getCategory(name = '') {
    const lowered = name.toLowerCase();
    if (ADULT_KEYWORDS.some(keyword => lowered.includes(keyword.toLowerCase()))) {
        return 'yellow';
    }
    if (ANIME_KEYWORDS.some(keyword => lowered.includes(keyword.toLowerCase()))) {
        return 'anime';
    }
    return 'general';
}

function getCategoryLabel(category) {
    switch (category) {
        case 'yellow':
            return '黄色';
        case 'anime':
            return '动漫';
        default:
            return '通用';
    }
}

function walkStrings(value, collector) {
    if (!value) {
        return;
    }

    if (typeof value === 'string') {
        collector(value);
        return;
    }

    if (Array.isArray(value)) {
        value.forEach(item => walkStrings(item, collector));
        return;
    }

    if (typeof value === 'object') {
        Object.values(value).forEach(item => walkStrings(item, collector));
    }
}

function extractUrlsFromSite(site, baseUrl) {
    const foundUrls = new Set();

    walkStrings(site, (text) => {
        const matches = text.match(/https?:\/\/[^\s"']+/g) || [];
        matches.forEach(match => {
            try {
                foundUrls.add(new URL(match, baseUrl).toString());
            } catch (_) {}
        });

        if (text.startsWith('./') || text.startsWith('../')) {
            try {
                const resolved = new URL(text, baseUrl).toString();
                foundUrls.add(resolved);
            } catch (_) {}
        }
    });

    return Array.from(foundUrls);
}

function classifyCandidate(url) {
    if (/\/api\.php\/provide\/vod(?:[/?]|$)/i.test(url)) {
        return { supported: true, sourceType: 'cms', reason: '' };
    }

    if (/\/api\.php\/app\/?$/i.test(url) || /\/api\.php\/app\//i.test(url)) {
        return { supported: false, sourceType: 'app', reason: 'APP接口格式，当前项目未直接支持' };
    }

    if (/mogai_api\.php/i.test(url)) {
        return { supported: false, sourceType: 'app', reason: '魔改APP接口，当前项目未直接支持' };
    }

    return { supported: false, sourceType: 'unknown', reason: '不是标准CMS/V10接口' };
}

function buildConvertibleSite(site, candidateUrl) {
    const category = getCategory(site.name || site.key || '');
    return {
        name: site.name || site.key || '未命名源',
        url: candidateUrl,
        detail: '',
        isAdult: category === 'yellow' || isAdultName(site.key || ''),
        category,
        categoryLabel: getCategoryLabel(category),
        origin: 'tvbox',
        sourceType: 'cms',
        tvboxKey: site.key || ''
    };
}

function convertTvboxSource(payload, sourceUrl, scope = 'all') {
    const sites = Array.isArray(payload?.sites) ? payload.sites : [];
    const supported = [];
    const unsupported = [];
    const seenUrls = new Set();

    for (const site of sites) {
        const candidateUrls = extractUrlsFromSite(site, sourceUrl);
        let matched = false;

        for (const candidateUrl of candidateUrls) {
            const classification = classifyCandidate(candidateUrl);
            if (classification.supported) {
                const normalized = candidateUrl.replace(/\/+$/, '');
                if (seenUrls.has(normalized)) {
                    matched = true;
                    continue;
                }

                const converted = buildConvertibleSite(site, normalized);
                if (
                    scope === 'adult' && !converted.isAdult ||
                    scope === 'normal' && converted.isAdult
                ) {
                    matched = true;
                    continue;
                }

                seenUrls.add(normalized);
                supported.push(converted);
                matched = true;
            } else if (classification.sourceType !== 'unknown') {
                unsupported.push({
                    name: site.name || site.key || '未命名源',
                    key: site.key || '',
                    category: getCategoryLabel(getCategory(site.name || site.key || '')),
                    sourceType: classification.sourceType,
                    candidateUrl,
                    reason: classification.reason
                });
                matched = true;
            }
        }

        if (!matched) {
            unsupported.push({
                name: site.name || site.key || '未命名源',
                key: site.key || '',
                category: getCategoryLabel(getCategory(site.name || site.key || '')),
                sourceType: 'unknown',
                candidateUrl: '',
                reason: '未发现可转换的接口地址'
            });
        }
    }

    return {
        customAPIs: supported,
        unsupportedSites: unsupported,
        summary: {
            totalSites: sites.length,
            supportedCount: supported.length,
            unsupportedCount: unsupported.length,
            adultCount: supported.filter(site => site.isAdult).length,
            normalCount: supported.filter(site => !site.isAdult).length
        }
    };
}

export async function onRequest(context) {
    const { request } = context;
    const requestUrl = new URL(request.url);

    if (request.method === 'OPTIONS') {
        return createJsonResponse({}, 204);
    }

    if (request.method !== 'GET') {
        return createJsonResponse({ success: false, error: '仅支持 GET 请求' }, 405);
    }

    const sourceUrl = requestUrl.searchParams.get('url');
    const scope = requestUrl.searchParams.get('scope') || 'all';
    if (!sourceUrl) {
        return createJsonResponse({ success: false, error: '缺少 url 参数' }, 400);
    }

    let normalizedUrl;
    try {
        normalizedUrl = normalizeGithubUrl(sourceUrl);
        const parsed = new URL(normalizedUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            throw new Error('URL 协议不支持');
        }
    } catch (error) {
        return createJsonResponse({ success: false, error: `无效的源地址: ${error.message}` }, 400);
    }

    try {
        const response = await fetch(normalizedUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
                'Accept': 'application/json,text/plain,*/*'
            },
            redirect: 'follow'
        });

        if (!response.ok) {
            return createJsonResponse({
                success: false,
                error: `抓取远程源失败: ${response.status} ${response.statusText}`
            }, 502);
        }

        const text = await response.text();
        let payload;
        try {
            payload = JSON.parse(text);
        } catch (error) {
            return createJsonResponse({
                success: false,
                error: `远程内容不是有效 JSON: ${error.message}`
            }, 400);
        }

        if (!Array.isArray(payload?.sites)) {
            return createJsonResponse({
                success: false,
                error: '该地址不是标准 TVBox/OK影视 配置，未找到 sites 数组'
            }, 400);
        }

        const converted = convertTvboxSource(payload, normalizedUrl, scope);
        return createJsonResponse({
            success: true,
            kind: 'tvbox-converted',
            sourceUrl: normalizedUrl,
            scope,
            ...converted,
            warnings: [
                '仅导入标准 CMS/V10 接口，例如 /api.php/provide/vod',
                'drpy、jar、XBPQ、App、直播源等不会直接导入到 LibreTV'
            ]
        });
    } catch (error) {
        return createJsonResponse({
            success: false,
            error: `转换失败: ${error.message}`
        }, 500);
    }
}
