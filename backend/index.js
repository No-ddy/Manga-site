//for importing modules
const express = require('express');// used for web frame work
const axios = require('axios');//it's an HTTP client type of stuff
const cheerio = require('cheerio');//used for HTML parsing
const archiver = require('archiver');//used zip creation
const fs = require('fs-extra');//used for file system operations
const path = require('path');//path utilities
const cors = require('cors');// cross-origin resource sharing, to get resources from multiple places
const rateLimit = require('axios-rate-limit');//to limit certain downloads and pull req 
const config = require('./config');
const PDFDocument = require('pdfkit'); // for creating PDFs
const streamBuffers = require('stream-buffers'); // to hold the PDF in memory before sending



const API_KEY = config.API_Key;//calls for the api key

//used to initialize the app
const app = express();

//configuration :)
const PORT = 8080;
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');// to create a folder to store the downloads

app.use(cors());
app.use(express.json());
// Ensure download directory exists
fs.ensureDirSync(DOWNLOAD_DIR);

// API endpoint to search manga
// Apply rate limiting to axios (1 request per second)
const limitedAxios = rateLimit(axios.create(), { 
    maxRequests: 1, 
    perMilliseconds: 1000 
});

//endpoint to search manga
app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;

    if (!q) {
      return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    const headers = {};
    if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;

    // Search MangaDex for the manga
    const response = await limitedAxios.get(
      `https://api.mangadex.org/manga`,
      {
        params: {
          title: q,
          limit: 10, // Get first 10 results (can change)
          includes: ['cover_art'], // Important: ask API to include cover_art info
          availableTranslatedLanguage: ['en'], // English only
        },
        headers,
      }
    );

    // Format the results nicely
    const results = response.data.data.map(manga => {
      const id = manga.id;
      const titleObj = manga.attributes.title;
      const title = titleObj.en || Object.values(titleObj)[0] || 'No title';

      // Get Cover URL
      let coverFileName = '';
      const coverRel = manga.relationships.find(rel => rel.type === 'cover_art');
      if (coverRel && coverRel.attributes && coverRel.attributes.fileName) {
        coverFileName = coverRel.attributes.fileName;
      }

      const coverUrl = coverFileName
        ? `https://uploads.mangadex.org/covers/${id}/${coverFileName}.512.jpg`
        : 'https://via.placeholder.com/150'; // fallback if no cover

      // Fixed URL (online mirror)
      const originalUrl = `https://mangadex.org/title/${id}`;
      const fixedUrl = originalUrl.replace('mangadex.org', 'mangadex.online');

      return {
        id,
        title,
        url: fixedUrl,
        coverUrl,  // <-- Added!
        downloadable: true, // For now assume all are downloadable
      };
    });

    res.json(results);

  } catch (error) {
    console.error('🔥 Search error:', error);
    res.status(500).json({ error: 'Failed to search manga', details: error.message });
  }
});

// API endpoint to get manga chapters
app.get('/api/manga/:id/chapters', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Prepare headers
        const headers = {};
        if (API_KEY) {
            headers['Authorization'] = `Bearer ${API_KEY}`;
        }

        // Get chapters from MangaDex API
        const response = await limitedAxios.get(`https://api.mangadex.org/manga/${id}/feed`, {
            params: {
                translatedLanguage: ['en'],
                order: { chapter: 'asc' },
                limit: 100
            },
            headers
        });
        
        // Process and return chapters
        const chapters = response.data.data.map(chapter => ({
            id: chapter.id,
            number: chapter.attributes.chapter || '0',
            title: chapter.attributes.title || '',
            pages: chapter.attributes.pages || 0
        }));

        res.json(chapters);
    } catch (error) {
        console.error('Chapters error:', error);
        res.status(500).json({ 
            error: 'Failed to get chapters',
            details: error.response?.data || error.message 
        });
    }
});

// API endpoint to download chapter
app.post('/api/download', async (req, res) => {
    console.log("it hit ✅✅✅");
    try {
      const { mangaId, chapterId, mangaTitle } = req.body; // Accept 1 chapter id
  
      if (!chapterId) {
        return res.status(400).json({ error: 'chapterId is required' });
      }
  
      const headers = {};
      if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;
  
      // Fetch chapter info
      const chapterResponse = await limitedAxios.get(
        `https://api.mangadex.org/chapter/${chapterId}`, { headers }
      );
      const chapterData = chapterResponse.data?.data;
  
      if (!chapterData || !chapterData.attributes?.hash) {
        console.error('❌ Invalid chapter data:', chapterResponse.data);
        return res.status(400).json({ error: 'This chapter has no downloadable content or is restricted' });
      }
  
      const hash = chapterData.attributes.hash;
      const server = chapterData.attributes.server || 'https://uploads.mangadex.org';
      const pages = chapterData.attributes.data || chapterData.attributes.dataSaver;
  
      if (!pages || pages.length === 0) {
        console.warn('⚠️ No pages found for chapter:', chapterId);
        return res.status(400).json({ error: 'No pages available for this chapter.' });
      }
  
      // Create PDF
      const doc = new PDFDocument({ autoFirstPage: false });
      const pdfBuffer = new streamBuffers.WritableStreamBuffer();
  
      doc.pipe(pdfBuffer);
  
      for (let i = 0; i < pages.length; i++) {
        const pageUrl = `${server}/data/${hash}/${pages[i]}`;
        const response = await limitedAxios.get(pageUrl, { responseType: 'arraybuffer' });
        const imageBuffer = Buffer.from(response.data, 'binary');
        
        // Add each page into the PDF
        doc.addPage().image(imageBuffer, {
          fit: [500, 700],
          align: 'center',
          valign: 'center',
        });
      }
  
      doc.end();
  
      // Wait for the PDF to finish generating
      await new Promise(resolve => doc.on('finish', resolve));
  
      // Send the PDF directly back
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${mangaTitle || mangaId}_${chapterId}.pdf"`);
      res.send(pdfBuffer.getContents());
  
    } catch (error) {
      console.error('🔥 Download error:', error);
      res.status(500).json({ error: 'Download failed', details: error.message });
    }
  });
// Endpoint to get readable image URLs for a chapter
app.get('/api/reader/:chapterId', async (req, res) => {
  const { chapterId } = req.params;

  try {
    const chapterRes = await axios.get(`https://api.mangadex.org/at-home/server/${chapterId}`);
    const imageBase = chapterRes.data.baseUrl;
    const chapterData = chapterRes.data.chapter;

    const imageUrls = chapterData.data.map(filename =>
      `${imageBase}/data/${chapterData.hash}/${filename}`
    );

    res.json({ images: imageUrls });
  } catch (error) {
    console.error('Failed to get chapter images:', error);
    res.status(500).json({ error: 'Failed to fetch reader images' });
  }
});

// Start the server
app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(API_KEY ? '🔐 API key is set' : '⚠️ No API key found, public access only');
});