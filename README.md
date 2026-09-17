# Otter diet metabarcoding viewer

A static website for viewing otter diet metabarcoding datasets (TSV) as 100% stacked barplots of read composition by **Label**. It runs entirely in the browser on GitHub Pages; no server or build step is needed.

## Repository structure

```
/
├── index.html          page layout (no dataset names in here)
├── style.css           styling
├── app.js              loading, checking, aggregation, plot and table
├── datasets.json       list of datasets shown in the sidebar
├── .nojekyll           tells GitHub Pages to serve files as-is
├── README.md
└── data/
    ├── color_code.tsv          Label → Color_code (shared by all datasets)
    ├── LN_R007_16S.tsv         dataset
    └── example_small.tsv       tiny dataset for checking the aggregation
```

## Dataset TSV format

Tab-separated, one header row:

```
Final_taxon  Label  Total_ASVs  <sample 1>  <sample 2>  …  Total_read
```

* Every column between `Total_ASVs` and `Total_read` is treated as a sample, in header order.
* There is no `Color_code` column; colors come from `data/color_code.tsv`.
* Empty and `NA` read cells count as 0. Other non-numeric values also count as 0 but are listed in the "Data check" panel.

## How the plot is calculated

For each dataset, all `Final_taxon` rows with the same `Label` are merged:

* Label reads per sample = sum of that Label's rows in that sample
* Label Total ASVs = sum of `Total_ASVs` over that Label's rows
* Label % in a sample = Label reads / all reads in that sample × 100

Samples with 0 total reads show an empty bar marked "no reads". The Table tab always shows the original rows, not the merged values. `data/example_small.tsv` reproduces the worked example: Sample1 is 75.10% No Hit and 24.90% Prey - Fish.

## Legend

Clicking a legend entry hides or shows that label. "Hide all labels" clears the plot so you can switch labels back on one at a time; "Show all labels" brings everything back. Bars keep each label's real share of the sample's reads, so with labels hidden the bars no longer reach 100%.

## Add a new dataset

1. Copy the file into `data/`, e.g. `data/12S_OBS1_Blocker.tsv`.
2. Add an entry to `datasets.json` (mind the comma between entries):

   ```json
   [
     { "name": "LN R007 16S", "file": "data/LN_R007_16S.tsv" },
     { "name": "12S OBS1 Blocker", "file": "data/12S_OBS1_Blocker.tsv" }
   ]
   ```

3. Commit and push. The dataset appears in the sidebar once GitHub Pages finishes deploying (usually 1–2 minutes).

The sidebar follows the order of `datasets.json`. File paths are case-sensitive on GitHub Pages, and must be relative (`data/x.tsv`, not `/data/x.tsv`).

## Change label colors

Edit `data/color_code.tsv` (tab-separated):

```
Label	Color_code
No Hit	#D2C4B4
Prey - Fish	#F4F754
```

* The Label text must match the dataset exactly, including internal spaces (for example `Artifact  (Primates)` has two spaces).
* Each Label may appear only once; duplicates are reported as errors and the first one is used.
* Labels missing from this file get a fallback color, shown with a dashed outline in the legend, and are listed in the "Data check" panel.

## Deploy on GitHub Pages

1. Create a repository on GitHub, e.g. `otter-diet-viewer`.
2. Upload all files, keeping the `data/` folder (GitHub web: *Add file → Upload files*, drag the whole folder in).
3. Go to *Settings → Pages*. Under *Build and deployment*, choose *Deploy from a branch*, branch `main`, folder `/ (root)`, then *Save*.
4. After a minute or two the site is at `https://USERNAME.github.io/otter-diet-viewer/`.

## Updates and caching

The app fetches `datasets.json` and every TSV with `cache: 'no-cache'`, so the browser checks with GitHub for a newer version every time. Updated TSV files show up as soon as the new deployment is live; a normal reload is enough.

If you edit `app.js` or `style.css`, increase the `?v=1` number on their lines in `index.html` (e.g. `?v=2`) so browsers load the new version.

## Links to a dataset

The address bar records the current dataset and tab, e.g. `…/#dataset=LN+R007+16S&view=table`, so you can bookmark or share a view.

## Preview locally

Browsers block data loading from `file://` pages, so use a small local server:

```
python3 -m http.server 8000
```

Then open http://localhost:8000/.

## Libraries

* [Plotly.js](https://plotly.com/javascript/) 2.35.2 from its CDN, for the plot.
* TSV parsing and the table are plain JavaScript. A TSV needs no quote handling, and this avoids breaking on taxon names that contain quote marks.
