const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database("history.db");

const API_ID = require('./secrets.json').id;
const API_KEY = require('./secrets.json').key;
const TOKEN = API_ID + ":" + API_KEY;

function sleep(ms) {
    return new Promise((res) => {
        setTimeout(res, ms);
    });
}

db.serialize(async () => {
    function sql(query) {
        return new Promise((res, rej) => {
            db.all(query, (err, data) => {
                if (err) {
                    rej(err);
                } else {
                    res(data);
                }
            });
        });
    }

    console.log("Preparing database...");
    await sql("CREATE TABLE IF NOT EXISTS published (id INT UNIQUE NOT NULL, processed BOOL NOT NULL, vote BOOL NOT NULL, PRIMARY KEY (id))");

    for (let image of await sql("SELECT * FROM images")) {
        if ((await sql("SELECT COUNT(*) FROM published WHERE id=" + image['id']))[0]["COUNT(*)"] === 0) {
            await sql("INSERT INTO published VALUES (" + image['id'] + ", FALSE, " + (image['liked'] ? "TRUE" : "FALSE") + ")");
        }
    }

    console.log("Publishing votes...");

    let list = await sql("SELECT * FROM published WHERE processed = FALSE");
    let index = 1;

    for (let image of list) {
        console.log(index + "/" + list.length + ": " + image['id'] + ": " + (image['vote'] ? "Upvote and favorite" : "Downvote and unfavorite"));

        try {
            await fetch("https://e621.net/posts/" + image['id'] + "/votes.json?no_unvote=true&score=" + (image['vote'] ? "1" : "-1"), {
                method: "POST",
                headers: {
                    "Authorization": "Basic " + btoa(TOKEN),
                    "User-Agent": "Mozilla/5.0 (+furbrowser; by RaindropsSys on e621)"
                }
            });

            if (image['vote']) {
                await fetch("https://e621.net/favorites.json?post_id=" + image['id'], {
                    method: "POST",
                    headers: {
                        "Authorization": "Basic " + btoa(TOKEN),
                        "User-Agent": "Mozilla/5.0 (+furbrowser; by RaindropsSys on e621)"
                    }
                });
            } else {
                await fetch("https://e621.net/favorites/" + image['id'] + ".json", {
                    method: "DELETE",
                    headers: {
                        "Authorization": "Basic " + btoa(TOKEN),
                        "User-Agent": "Mozilla/5.0 (+furbrowser; by RaindropsSys on e621)"
                    }
                });
            }

            await sql("UPDATE published SET processed = TRUE WHERE id  = " + image['id']);
            await sleep(1000);
        } catch (e) {
            console.error(e);
        }

        index++;
    }

    db.close();
});
