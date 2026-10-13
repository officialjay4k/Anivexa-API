// ============================================================
// Cloud Hub — home.js
// ============================================================

const ANILIST_GRAPHQL = CH.ANILIST_GRAPHQL;
const HERO_ROTATE_MS = 8000;
const HERO_COUNT = 5;

let heroSlides = [];
let heroIndex = 0;
let heroTimer = null;
let heroTmdbCache = [];

async function anilistQuery(query, variables = {}) {
  const res = await fetch(ANILIST_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}

const SPOTLIGHT_QUERY = `
  query {
    Page(page: 1, perPage: 12) {
      media(type: ANIME, status: RELEASING, sort: TRENDING_DESC, isAdult: false) {
        id
        title { romaji english }
        coverImage { extraLarge large }
        bannerImage
        description(asHtml: false)
        format
        episodes
        seasonYear
        averageScore
        genres
      }
    }
  }
`;

const LATEST_QUERY = `
  query {
    Page(page: 1, perPage: 30) {
      media(type: ANIME, status: RELEASING, sort: POPULARITY_DESC, isAdult: false) {
        id
        title { romaji english }
        coverImage { extraLarge large }
        format
        averageScore
        seasonYear
        episodes
        nextAiringEpisode { episode airingAt }
      }
    }
  }
`;

const POPULAR_QUERY = `
  query {
    Page(page: 1, perPage: 18) {
      media(type: ANIME, sort: POPULARITY_DESC, isAdult: false) {
        id
        title { romaji english }
        coverImage { extraLarge large }
        format
        averageScore
        seasonYear
      }
    }
  }
`;

const SCHEDULE_QUERY = `
  query {
    Page(page: 1, perPage: 40) {
      media(type: ANIME, status: RELEASING, sort: POPULARITY_DESC, isAdult: false) {
        id
        title { romaji english }
        coverImage { extraLarge large }
        bannerImage
        format
        averageScore
        nextAiringEpisode { episode airingAt
