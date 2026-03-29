# DBLP Masterfile Generator

This project provides a small Angular web application for generating
protagonist-centred storyline instances from the DBLP bibliographic database.

The tool connects to the public DBLP SPARQL endpoint, applies configurable
filters (years, publication types, venues, coauthor thresholds, top-k focus),
and exports the resulting collaboration instances in the `.master` format used
by Hegemann and Wolff for protagonist storylines.

The app is intended as a data preparation tool for experiments on crossing
minimization in storyline visualizations.
