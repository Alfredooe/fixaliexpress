export default {
  async fetch(request, env, ctx) {
    console.log("Worker started processing request");
    var url = new URL(request.url);
    const userAgent = request.headers.get("user-agent");
    console.log("User Agent:", userAgent);

    const ALIEXPRESS_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';

    const sendDiscordWebhook = async (itemId, title, aliExpressUrl, imageUrl) => {
      if (!env.DISCORD_WEBHOOK) {
        console.log("Discord webhook not configured, skipping notification");
        return;
      }

      try {
        const webhookPayload = {
          embeds: [{
            title: "AliExpress Embed Generated",
            description: `Successfully generated embed for: ${title}`,
            color: 0xFF0000, // Red color
            fields: [
              {
                name: "Item ID",
                value: itemId,
                inline: true
              },
              {
                name: "AliExpress URL",
                value: aliExpressUrl,
                inline: false
              }
            ],
            image: {
              url: imageUrl
            },
            timestamp: new Date().toISOString()
          }]
        };

        const webhookResponse = await fetch(env.DISCORD_WEBHOOK, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(webhookPayload)
        });

        if (webhookResponse.ok) {
          console.log("Discord webhook sent successfully");
        } else {
          console.error("Failed to send Discord webhook:", webhookResponse.status);
        }
      } catch (error) {
        console.error("Error sending Discord webhook:", error);
      }
    };

    // If the url matches being a `a.aliexpress.com/<random>` link
    // then we need to request it and get the redirect it points to.
    if ( url.href.match(/a\.alimbedxpress\.com\/.*/) ) {
      const test_response = await fetch(`https://a.aliexpress.com/${url.pathname}`, {
        redirect: 'manual',
        headers: {
          'User-Agent': ALIEXPRESS_UA
        }
      });
      // These links just redirect straight through to a /item/ url
      url = new URL(test_response.headers.get("location"));
    }
    
    const match = url.pathname.match(/\/(item|i)\/(\d+)\.html/);
    if (!match) {
      console.log("Invalid URL format:", url.pathname);
      return new Response("Invalid URL format", { status: 400 });
    }
    
    const itemId = match[2];
    const aliExpressUrl = `https://www.aliexpress.com/item/${itemId}.html`;
    console.log("AliExpress URL:", aliExpressUrl);
    let title = 'AliExpress Product';
    let description = `Item ID: ${itemId}`;
    let imageUrl = "https://ae01.alicdn.com/kf/Sb900db0ad7604a83b297a51d9222905bm/624x160.png";

    const getHtmlViaBrowserRendering = async (targetUrl) => {
      if (!env.MYBROWSER) return null;

      // Lazy import so the Worker can still run even if nodejs_compat / package isn't present yet.
      const { default: puppeteer } = await import("@cloudflare/puppeteer");
      const browser = await puppeteer.launch(env.MYBROWSER);
      try {
        const page = await browser.newPage();
        await page.setUserAgent(ALIEXPRESS_UA);

        // Block unnecessary resources to speed up page load.
        await page.setRequestInterception(true);
        page.on('request', (req) => {
          const resourceType = req.resourceType();
          // Block images, stylesheets, fonts, media — we only need the HTML/JS for meta tags.
          if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
            req.abort();
          } else {
            req.continue();
          }
        });

        // Use domcontentloaded instead of networkidle2 — faster, usually enough for meta tags.
        // Set a 8-second timeout to fail fast if the page is slow.
        await page.goto(targetUrl, { 
          waitUntil: "domcontentloaded",
          timeout: 8000
        });

        // Give JS a brief moment to populate meta tags if needed.
        await new Promise(resolve => setTimeout(resolve, 500));

        return await page.content();
      } finally {
        await browser.close();
      }
    };

    // For Discord requests, skip the blocking fetch here — we'll do it inside the streaming handler.
    const isDiscord = userAgent && userAgent.includes("Discord");

    if (!isDiscord) {
      try {
        console.log("Fetching AliExpress page");

        let html = null;
        try {
          html = await getHtmlViaBrowserRendering(aliExpressUrl);
          if (html) {
            console.log("Browser Rendering HTML length:", html.length);
          }
        } catch (e) {
          console.warn("Browser Rendering failed, falling back to normal fetch:", e);
        }

        if (!html) {
          var aliexpressAttempts = 1;
          var response;
          while (true) {
            response = await fetch(aliExpressUrl, {
              redirect: 'manual',
              headers: {
                'User-Agent': ALIEXPRESS_UA
              }
            });

            console.log(`AliExpress response status (Attempt ${aliexpressAttempts}/5): ${response.status}`);
            
            if (response.ok) {
              break;
            }
            if ( aliexpressAttempts >= 5 ) {
              break;
            }
            aliexpressAttempts++;
          }

          if (response.ok) {
            html = await response.text();
            console.log("AliExpress HTML length:", html.length);
          }
        }

        if (html) {

          const getMetaContent = (name) => {
            const match = html.match(new RegExp(`<meta\\s+property="og:${name}"\\s+content="([^"]*)"`, 'i'));
            console.log(`Extracting og:${name}:`, match ? match[1] : "Not found");
            return match ? match[1] : null;
          };

          title = getMetaContent('title') || title;
          description = getMetaContent('description') || description;
          imageUrl = getMetaContent('image') || imageUrl;
        } else {
          console.log("Failed to fetch AliExpress page, using fallback data");
        }
      } catch (error) {
        console.error("Error fetching AliExpress page:", error);
        console.log("Using fallback data due to error");
      }
    }

    if (isDiscord) {
      console.log("Preparing Discord embed with streaming stall technique");
      const color = "#FF0000";

      // Use a TransformStream to drip bytes while Browser Rendering works.
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      // Start responding immediately with the HTML preamble.
      const preamble = `<!DOCTYPE html>
<html>
<head>
  <meta content="text/html; charset=UTF-8" http-equiv="Content-Type" />
  <!-- Waiting for product data -->`;

      // Kick off the streaming response handler in the background.
      ctx.waitUntil((async () => {
        try {
          await writer.write(encoder.encode(preamble));

          // Drip whitespace/comments every 500ms while we wait for Browser Rendering.
          // We'll race between the data fetch and a timeout.
          const MAX_STALL_MS = 25000; // Max time to stall before giving up
          const DRIP_INTERVAL_MS = 500;
          const startTime = Date.now();

          let fetchedTitle = title;
          let fetchedDescription = description;
          let fetchedImageUrl = imageUrl;
          let dataReady = false;

          // Start Browser Rendering fetch in parallel.
          const fetchPromise = (async () => {
            try {
              let html = null;
              try {
                html = await getHtmlViaBrowserRendering(aliExpressUrl);
                if (html) {
                  console.log("Browser Rendering HTML length:", html.length);
                }
              } catch (e) {
                console.warn("Browser Rendering failed in streaming path:", e);
              }

              // Fallback to normal fetch if Browser Rendering failed.
              if (!html) {
                let attempts = 0;
                while (attempts < 5) {
                  attempts++;
                  const r = await fetch(aliExpressUrl, {
                    redirect: 'manual',
                    headers: { 'User-Agent': ALIEXPRESS_UA }
                  });
                  if (r.ok) {
                    html = await r.text();
                    break;
                  }
                }
              }

              if (html) {
                const getMetaContent = (name) => {
                  const m = html.match(new RegExp(`<meta\\s+property="og:${name}"\\s+content="([^"]*)"`, 'i'));
                  return m ? m[1] : null;
                };
                fetchedTitle = getMetaContent('title') || fetchedTitle;
                fetchedDescription = getMetaContent('description') || fetchedDescription;
                fetchedImageUrl = getMetaContent('image') || fetchedImageUrl;
              }
            } catch (e) {
              console.error("Error in streaming fetch:", e);
            }
            dataReady = true;
          })();

          // Drip loop: send whitespace/comments while waiting.
          let dripCount = 0;
          while (!dataReady && (Date.now() - startTime) < MAX_STALL_MS) {
            await new Promise(resolve => setTimeout(resolve, DRIP_INTERVAL_MS));
            if (!dataReady) {
              dripCount++;
              // Send a small comment to keep the connection alive.
              await writer.write(encoder.encode(`\n  <!-- . -->`));
              if (dripCount % 10 === 0) {
                console.log(`Still waiting for data... ${Math.round((Date.now() - startTime) / 1000)}s elapsed`);
              }
            }
          }

          // Wait for fetch to complete if it hasn't already (with a small grace period).
          if (!dataReady) {
            await Promise.race([
              fetchPromise,
              new Promise(resolve => setTimeout(resolve, 2000))
            ]);
          }

          // Now send the rest of the HTML with the (hopefully real) data.
          const restOfHead = `
  <title>${fetchedTitle}</title>
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="theme-color" content="${color}">
  <meta property="og:site_name" content="alimbedxpress.com created by alf">
  <meta property="og:title" content="${fetchedTitle}" />
  <meta property="og:image" content="${fetchedImageUrl}" />
  <meta property="og:description" content="${fetchedDescription}" />
  <meta name="twitter:title" content="AliExpress - ${itemId}" />
  <meta name="twitter:image" content="${fetchedImageUrl}" />
  <meta name="twitter:creator" content="@aliexpress" />
</head>
<body>
  <h1>${fetchedTitle}</h1>
  <p>${fetchedDescription}</p>
  <p>Click to view on AliExpress</p>
  <img src="${fetchedImageUrl}" alt="${fetchedTitle}">
</body>
</html>`;

          await writer.write(encoder.encode(restOfHead));
          await writer.close();

          console.log(`Streaming response completed. Total time: ${Date.now() - startTime}ms`);

          // Fire webhook with the fetched data.
          await sendDiscordWebhook(itemId, fetchedTitle, aliExpressUrl, fetchedImageUrl);

        } catch (e) {
          console.error("Streaming response error:", e);
          try {
            // Try to close gracefully with fallback content.
            const fallback = `
  <title>${title}</title>
  <meta property="og:title" content="${title}" />
  <meta property="og:image" content="${imageUrl}" />
</head>
<body><h1>${title}</h1></body>
</html>`;
            await writer.write(encoder.encode(fallback));
            await writer.close();
          } catch (closeErr) {
            console.error("Failed to close stream:", closeErr);
            await writer.abort();
          }
        }
      })());

      // Return the streaming response immediately.
      return new Response(readable, {
        headers: {
          "content-type": "text/html; charset=UTF-8",
        }
      });
    }

    console.log("Redirecting to AliExpress");
    return Response.redirect(aliExpressUrl, 302);
  },
};
