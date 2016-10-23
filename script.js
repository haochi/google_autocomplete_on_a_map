(function (window) {
    const app = angular.module('app', ['ngSanitize']);
    const googleSuggestBaseUrl = 'https://www.google.com/complete/search';

    app.service('googleSuggestionService', function ($http, $q, $templateCache, $sanitize) {
        const queryRegEx = /_+/g;
        const div = document.createElement('div');

        this.querySubstitution = (query, placeName) => {
            let substitutedQuery;

            if (query.match(queryRegEx)) {
                substitutedQuery = `${query} `.replace(queryRegEx, placeName);
            } else {
                substitutedQuery = `${query} ${placeName}`;
            }

            return substitutedQuery;
        };

        this.searchQueryForLocation = function (query, placeName) {
            let substitutedQuery = this.querySubstitution(query, placeName);

            return $http({
                url: googleSuggestBaseUrl + '?callback=JSON_CALLBACK',
                method: 'JSONP',
                params: {
                    sclient: 'psy-ab',
                    q: substitutedQuery
                },
                cache: $templateCache
            }).then(function (result) {
                let suggestions;
                try {
                    suggestions = result.data[1];
                } catch (e) {
                    suggestions = [];
                }
                return extractHighlight(suggestions);
            });
        };

        /**
         * @param {Array.<Array.<Object>>} suggestions
         * @return {object}
         * */
        function extractHighlight(suggestions) {
            let highlight = '';
            let suggestion = '';

            while (suggestions.length > 0) {
                let input = suggestions.shift()[0];
                div.innerHTML = $sanitize(input);
                let highlights = Array.from(div.querySelectorAll('b'));

                if (highlights.length > 0) {
                    highlight = Array.from(highlights).map(function (portion) {
                        return portion.textContent;
                    }).join(' ').trim();
                    suggestion = div.textContent;
                    break;
                }
            }
            return {highlight, suggestion};
        }
    });

    app.directive('suggestionMap', function () {
        return {
            controller: 'SuggestionMapController',
            controllerAs: 'ctrl',
            templateUrl: 'suggestionMap.html',
            link ($scope, $element, $attrs, ctrl) {
                ctrl.dataMap = new Datamap({
                    scope: $attrs.map,
                    element: $element[0].querySelector('.map'),
                    responsive: true
                });

                ctrl.dataMap.addPlugin('customLabels', handleCustomLabels);

                function resizeMap() {
                    ctrl.dataMap.resize();
                }

                window.addEventListener('resize', resizeMap);
                $element.on('destroy', function () {
                    window.removeEventListener('resize', resizeMap);
                });
            }
        }
    });

    app.controller('SuggestionMapController', function (googleSuggestionService, dataMapService, $attrs, $q, $location) {
        const { map, defaultQuery } = $attrs;
        const queryParam = 'q';

        this.query = $location.search()[queryParam] || defaultQuery;
        this.sampleQuery = '';

        this.search = () => {
            const geos = dataMapService.getGeosOnMap(map);
            const requests = geos.map(geo => googleSuggestionService.searchQueryForLocation(this.query, geo.name));
            this.substitutedQuery = googleSuggestionService.querySubstitution(this.query, '{state name}');
            $location.search(queryParam, this.query);

            $q.all(requests).then(suggestions => {
                const customLabelText = geos.reduce((memo, geo, index) => {
                    memo[geo.id] = suggestions[index].highlight;
                    return memo;
                }, {});

                const queriesByState = geos.reduce((memo, geo, index) => {
                    memo[geo.id] = suggestions[index].suggestion;
                    return memo;
                }, {});

                this.dataMap.customLabels({
                    customLabelText,
                    on: {
                        click (d) {
                            const query = queriesByState[d.id];
                            if (query) {
                                window.open('https://www.google.com/?q=' + encodeURIComponent(query));
                            }
                        }
                    }
                });
            });
        };

        this.selectSampleQuery = () => {
            this.query = this.sampleQuery;
            this.sampleQuery = '';
            this.search();
        };

        this.debounce = 1000;

        this.$postLink = () => {
            this.search();
        };
    });

    app.service('dataMapService', function ($window) {
        const dataMapPrototype = $window.Datamap.prototype;
        const getGeos = (geometries) => {
            return geometries.map(function (geo) {
                return {id: geo.id, name: geo.properties.name};
            });
        };
        const usaGeos = getGeos(dataMapPrototype.usaTopo.objects.usa.geometries);
        const worldGeos = getGeos(dataMapPrototype.worldTopo.objects.world.geometries);

        this.getGeosOnMap = (scope) => {
            if (scope === 'usa') {
                return usaGeos;
            }
            if (scope === 'world') {
                return worldGeos;
            }
            return [];
        }
    });

    app.config(function ($sceDelegateProvider) {
        $sceDelegateProvider.resourceUrlWhitelist([
            'self',
            googleSuggestBaseUrl + '**'
        ]);
    });

    function handleCustomLabels(layer, {fontSize = 13, customLabelText = {}, on = {}} = {}) {
        const self = this;

        const labelStartCoordinates = self.projection([-70, 41.5]);
        const smallStates = ["VT", "NH", "MA", "RI", "CT", "NJ", "DE", "MD", "DC"];
        const adjustments = {
            CA: { x: -50 },
            FL: { x: 40 },
            WV: { x: -20, y: 10 },
            ID: { x: -20, y: 60 },
            LA: { x: -20, y: 20 },
            MI: { x: 20, y: 50 }
        };
        const smallStateGap = 5;
        const labelClass = 'datamaps-text-label';
        const svg = this.svg;

        svg.selectAll(`.${labelClass}`).remove();
        svg.selectAll(".datamaps-subunit")
            .each((d) => {
                let [labelX, labelY] = self.path.centroid(d);
                const [[x0, y0], [x1, y1]] = self.path.bounds(d);
                const smallStateIndex = smallStates.indexOf(d.id);

                layer.append("text")
                    .classed(labelClass, true)
                    .style("font-size", `${fontSize }px`)
                    .each(function () {
                        const element = d3.select(this);

                        if (~smallStateIndex) {
                            labelX = labelStartCoordinates[0];
                            labelY = labelStartCoordinates[1] + (smallStateIndex * (smallStateGap + fontSize));
                        } else {
                            const xDiff = x1 - x0;
                            const yDiff = y1 - y0;

                            labelX = x0 + (xDiff - this.clientWidth) / 2;
                            labelY = y0 + (yDiff - this.clientHeight) / 2;
                        }

                        if (adjustments.hasOwnProperty(d.id)) {
                            let { x: adjustmentX, y: adjustmentY } = adjustments[d.id];
                            labelX += adjustmentX || 0;
                            labelY += adjustmentY || 0;
                        }

                        if (customLabelText[d.id]) {
                            const prefix = smallStates.includes(d.id) ? `${d.id}:  ` : '';
                            const display = prefix + customLabelText[d.id];
                            element.text(display);
                            element.on('click', () => {
                                on.click(d);
                            });
                        }

                        element.attr({
                            x: labelX,
                            y: labelY
                        });
                    });
            });
    }
})(window);
