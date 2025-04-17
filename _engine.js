const API_ID = require('./secrets.json').id;
const API_KEY = require('./secrets.json').key;

const chalk = require('chalk');

console.clear();
console.log(chalk.red("Starting application..."));

const prompts = require('prompts');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database("history.db");
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const zlib = require("zlib");

const blacklist = fs.readFileSync("./blacklist.txt").toString().trim().split("\n").filter(i => i.trim() !== "" && !i.trim().startsWith("#"));

let tmp = fs.mkdtempSync(os.tmpdir() + "/furbrowser-");

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

    async function generateReport() {
        console.clear();
        console.log(chalk.red("Generating report: Creating report table..."));

        let imageCount = (await sql("SELECT COUNT(*) FROM images"))[0]["COUNT(*)"];
        await sql("DROP TABLE IF EXISTS report");
        await sql("CREATE TABLE report (tag TEXT NOT NULL, disliked FLOAT, liked FLOAT, weight FLOAT, score FLOAT, PRIMARY KEY (tag))");

        let tags = await sql("SELECT * FROM tags");

        tags.map(i => {
            i['_breakdown'] = i['dislikes'] / i['total'];
            i['_percentage'] = i['total'] / imageCount;
            return i;
        });

        tags.sort((a, b) => b['total'] - a['total']);
        tags.sort((a, b) => b['_breakdown'] - a['_breakdown']);

        for (let tag of tags) {
            await sql("INSERT INTO report VALUES ('" + tag['name'].replaceAll("'", "''") + "', " + (tag['_breakdown'] * 100) + ", " + (100 - (tag['_breakdown'] * 100)) + ", " + ((tag['total'] / imageCount) * 100) + ", " + ((1 - tag['_breakdown']) * (tag['total'] / imageCount)) + ")")
        }

        console.clear();
        console.log(chalk.red("Generating report: Exporting prediction model..."));

        let fullReport = await sql("SELECT * FROM report");
        let highestScore = Math.max(...fullReport.map(i => i['score']));
        let properReport = {};

        for (let item of fullReport) {
            properReport[item["tag"]] = item["score"] / highestScore;
        }

        fs.writeFileSync("fullmodel.fbd", zlib.deflateRawSync(JSON.stringify(properReport)));
        return tags;
    }

    async function quit() {
        let tags = await generateReport();

        console.clear();
        console.log(chalk.red("Generating report: Preparing suggestions..."));
        tags = tags.filter(i => !blacklist.includes(i['name']));

        let tagsDisplay = tags.slice(0, process.stdout.rows - 4);

        process.stdout.moveCursor(0, -1);
        process.stdout.clearLine(null);

        console.log(chalk.cyan("You might want to block these tags:\n"));
        let longestTagDisplay = Math.max(...tagsDisplay.map(i => i['name'].length));

        for (let tag of tagsDisplay) {
            if (tag['total'] > 12) {
                console.log(chalk.blue("* ") + (tag['name'] + " ".repeat(longestTagDisplay - tag['name'].length) + "  (" + (tag['_breakdown'] * 100).toFixed(1) + "%, based on " + (tag['_percentage'] * 100).toFixed(2) + "% (" + tag['total'] + ") of images)"));
            } else {
                console.log(chalk.blue("* ") + chalk.gray(tag['name'] + " ".repeat(longestTagDisplay - tag['name'].length) + "  (" + (tag['_breakdown'] * 100).toFixed(1) + "%, based on " + (tag['_percentage'] * 100).toFixed(2) + "% (" + tag['total'] + ") of images)"));
            }
        }

        console.log(chalk.red("Saving data..."));

        db.close(async () => {
            fs.rmSync(tmp, { recursive: true });
            process.stdout.moveCursor(0, -1);
            process.stdout.clearLine(null);

            console.log("");
            process.exit(1);
        });
    }

    process.on('SIGINT', () => {
        quit();
    });

    await sql("CREATE TABLE IF NOT EXISTS tags (name TEXT NOT NULL, likes INT, dislikes INT, total INT, PRIMARY KEY (name))");
    await sql("CREATE TABLE IF NOT EXISTS images (id INT NOT NULL, liked BOOL, disliked BOOL, tags LONGTEXT, PRIMARY KEY (id))");
    let doIt = true;
    let page = 1;
    let lastPage = -10;

    while (doIt) {
        const TOKEN = API_ID + ":" + API_KEY;

        console.clear();
        console.log(chalk.red("Downloading resources... Page " + page));
        let imageCount = (await sql("SELECT COUNT(*) FROM images"))[0]["COUNT(*)"];

        const response = await fetch("https://e621.net/posts.json?limit=320&tags=" + encodeURIComponent(global.query) + "&page=" + page, {
            headers: {
                "Authorization": "Basic " + btoa(TOKEN),
                "User-Agent": "Mozilla/5.0 (+furbrowser; by RaindropsSys on e621)"
            }
        });

        let res = await response.json();
        page++;

        let items = res['posts'].filter(item => {
            let tags = Object.values(item['tags']).reduce((a, b) => [...a, ...b]);

            for (let tag of tags) {
                if (blacklist.includes(tag)) {
                    return false;
                }
            }

            return true;
        });

        let items2 = [];

        for (let item of items) {
            if (!((await sql("SELECT COUNT(*) FROM images WHERE id=" + item['id']))[0]["COUNT(*)"] > 0)) {
                items2.push(item);
            }
        }

        items = items2.filter(i => i["file"]["url"]);
        let model;
        let averageScore;

        if (items.length > 0 && page - lastPage >= 10) {
            await generateReport();

            console.clear();
            console.log(chalk.red("Generating report: Loading predictions model..."));

            try {
                model = JSON.parse(zlib.inflateRawSync(fs.readFileSync("fullmodel.fbd")).toString());
            } catch (e) {
                model = {};
            }

            console.clear();
            process.stdout.write(chalk.red("Generating report: Collecting scores for previous images..."));

            averageScore = 0;
            let scoresForExistingImages = [];
            let images = await sql("SELECT * FROM images");

            for (let image of images) {
                process.stdout.cursorTo(0);
                let t = "Generating report: Collecting scores for previous images... " + ((scoresForExistingImages.length / images.length) * 100).toFixed(1) + "%";
                process.stdout.write(chalk.red(t) + " ".repeat(process.stdout.columns - 1 - t.length));

                let tags = image['tags'].split(",");

                let score;

                try {
                    let scoresForTags = tags.filter(i => Object.keys(model).includes(i)).map(i => model[i]);
                    score = scoresForTags.reduce((a, b) => a + b) / scoresForTags.length;
                } catch (e) {}

                if (score) {
                    scoresForExistingImages.push(score);
                }
            }

            if (scoresForExistingImages.length > 0) {
                averageScore = scoresForExistingImages.reduce((a, b) => a + b) / scoresForExistingImages.length;
            }

            scoresForExistingImages = null;
            lastPage = page;
        }

        for (let item of items) {
            console.clear();
            console.log(chalk.red("Finding next image..."));

            let tags = Object.values(item['tags']).reduce((a, b) => [...a, ...b]);
            let url = item["file"]['url'];
            let id = item['id'];

            console.clear();
            let tagDisplay = tags.join(", ");
            let maxTagLength = tags.length;

            console.clear();

            let header = imageCount + " · Image: #" + id + " · " + tagDisplay + " · " + new Date(item["created_at"]).toISOString().split(".")[0].replace("T", " ") + " · " + item['file']['width'] + "x" + item['file']['height'];

            while (header.length > process.stdout.columns) {
                maxTagLength--;

                if (tags.length > maxTagLength) {
                    tagDisplay = tags.slice(0, maxTagLength).join(", ") + ", and " + (tags.length - maxTagLength) + " other tags";
                }

                header = imageCount + " · Image: #" + id + " · " + tagDisplay + " · " + new Date(item["created_at"]).toISOString().split(".")[0].replace("T", " ") + " · " + item['file']['width'] + "x" + item['file']['height'];
            }

            console.log(chalk.gray(header));
            console.log(chalk.red("Downloading image... " + id));
            fs.writeFileSync(tmp + "/" + id, Buffer.from(await (await fetch(url)).arrayBuffer()));

            process.stdout.moveCursor(0, -1);
            process.stdout.clearLine(null);

            console.log("");

            if (item['file']['ext'] === "webm" || item['file']['ext'] === "swf") {
                let r = await prompts([
                    {
                        name: 'confirm',
                        type: 'text',
                        message: "This is a video, open it with ffplay?",
                        validate: (t) => t.toLowerCase().trim() === "y" || t.toLowerCase().trim() === "n"
                    }
                ]);

                if (!r['confirm']) {
                    await quit();
                    return;
                } else if (r['confirm'] === "y") {
                    cp.execSync("ffplay -loglevel panic \"" + tmp + "/" + id + "\"", { stdio: "inherit" });
                } else {
                    continue;
                }
            } else {
                cp.execSync("imgcat -r -H " + (process.stdout.rows - 6) + " \"" + tmp + "/" + id + "\"", { stdio: "inherit" });
            }

            console.log("");

            let score = 0;

            try {
                let scoresForTags = tags.filter(i => Object.keys(model).includes(i)).map(i => model[i]);
                score = scoresForTags.reduce((a, b) => a + b) / scoresForTags.length;
            } catch (e) {}

            let difference = score - averageScore;

            let str = "Likelihood: " + (score * 100).toFixed(2) + "% (" + (difference > 0 ? "+" : "-") + Math.abs(difference * 100).toFixed(2) + "%) · " + tags.join(", ");
            console.log(str.substring(0, process.stdout.columns - 1).replaceAll(", ", chalk.yellow(", ")) + (str.length > process.stdout.columns - 1 ? chalk.gray("…") : ""));

            let suggested = "";
            if (Math.abs(difference) > 0.01) {
                if (difference > 0) suggested = "u";
                if (difference < 0) suggested = "d";
            }

            let r = await prompts([
                {
                    name: 'confirm',
                    type: 'text',
                    message: "What do you do with this image? " + (suggested === "u" ? chalk.green(chalk.underline("U") + "pvote") : chalk.underline("U") + "pvote") + " or " + (suggested === "d" ? chalk.green(chalk.underline("d") + "ownvote") : chalk.underline("d") + "ownvote") + "?",
                    validate: (t) => t.toLowerCase().trim() === "u" || t.toLowerCase().trim() === "d"
                }
            ]);

            if (!r['confirm']) {
                await quit();
                return;
            } else {
                imageCount++;

                console.clear();
                console.log(chalk.red("Processing image... " + id));

                fs.rmSync(tmp + "/" + id);
                let upvote = r['confirm'].toLowerCase().trim() === "u";
                await sql("INSERT INTO images VALUES (" + id + ", " + (upvote ? "TRUE" : "FALSE") + ", " + (upvote ? "FALSE" : "TRUE") + ", '" + tags.join(",").replaceAll("'", "''") + "')");

                for (let tag of tags) {
                    if ((await sql("SELECT COUNT(*) FROM tags WHERE name='" + tag.replaceAll("'", "''") + "'"))[0]["COUNT(*)"] > 0) {
                        await sql("UPDATE tags SET " + (upvote ? "likes" : "dislikes") + " = " + (upvote ? "likes" : "dislikes") + " + 1, total = total + 1 WHERE name='" + tag.replaceAll("'", "''") + "'");
                    } else {
                        await sql("INSERT INTO tags VALUES ('" + tag.replaceAll("'", "''") + "', " + (upvote ? "1" : "0") + ", " + (upvote ? "0" : "1") + ", 1)");
                    }
                }
            }
        }
    }
});
