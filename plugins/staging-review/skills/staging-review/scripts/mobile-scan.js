// 375px phone-width scan of every sitemap page (SKILL.md, check 5).
//
// Paste into the browser's JavaScript tool on ANY page of the site under review
// (same origin, so the iframe can be measured). It starts in the background and
// returns "started"; poll with:
//     window.__mobile ? JSON.stringify(window.__mobile) : ({ p: window.__progress })
// Media queries inside a 375px iframe use the iframe's width, so this is a real
// phone-layout test. Takes ~1-2 s per page; run one site per tab to parallelise.
// A page is reported when it scrolls sideways (scrollWidth > 375) or has a broken
// image. "offenders" names the outermost elements poking past the right edge.
window.__mobile = null
window.__runMobile = async () => {
    const xml = await (await fetch("/sitemap.xml")).text()
    const urls = ["/"].concat(
        [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname).filter((p) => p !== "/"),
    )
    const W = 375
    const out = []
    window.__progress = 0
    const ifr = document.createElement("iframe")
    ifr.style.cssText = `position:fixed;left:0;top:0;width:${W}px;height:812px;border:0;z-index:99999;background:#fff`
    document.body.appendChild(ifr)
    for (const u of urls) {
        await new Promise((r) => {
            ifr.onload = r
            ifr.src = u
            setTimeout(r, 15000)
        })
        await new Promise((r) => setTimeout(r, 600))
        try {
            const d = ifr.contentDocument
            const sw = d.documentElement.scrollWidth
            const offenders = []
            if (sw > W + 1) {
                for (const el of d.body.querySelectorAll("*")) {
                    const r = el.getBoundingClientRect()
                    if (r.width > 0 && r.right > W + 2 && getComputedStyle(el).position !== "fixed") {
                        const p = el.parentElement && el.parentElement.getBoundingClientRect()
                        if (!p || p.right <= W + 2) {
                            const cls = String(el.getAttribute("class") || "").split(" ").slice(0, 3).join(".")
                            offenders.push(`${el.tagName.toLowerCase()}.${cls} -> ${Math.round(r.right)}px "${(el.innerText || "").trim().slice(0, 40)}"`)
                        }
                    }
                    if (offenders.length >= 4) break
                }
            }
            const brokenImgs = [...d.images]
                .filter((i) => i.complete && i.naturalWidth === 0 && i.currentSrc)
                .map((i) => i.currentSrc.split("/").pop())
                .slice(0, 3)
            if (sw > W + 1 || brokenImgs.length) out.push({ u, scrollWidth: sw, offenders, brokenImgs })
        } catch (e) {
            out.push({ u, err: String(e) })
        }
        window.__progress++
    }
    ifr.remove()
    window.__mobile = { total: urls.length, issues: out }
}
window.__runMobile()
;("started")
