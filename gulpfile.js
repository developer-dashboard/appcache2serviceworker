'use strict';

const gulp = require('gulp');

const SRC_DIR = 'src';
const BUILD_DIR = 'build';

gulp.task('clean', () => {
  const del = require('del');

  return del(BUILD_DIR);
});

gulp.task('lint', () => {
  const eslint = require('gulp-eslint');

  return gulp.src(`${SRC_DIR}/**/*.js`)
    .pipe(eslint())
    .pipe(eslint.format())
    .pipe(eslint.failOnError());
});

gulp.task('build', () => {
  const browserify = require('browserify');
  const buffer = require('vinyl-buffer');
  const source = require('vinyl-source-stream');

  [
    'register-service-worker.js',
    'legacy-appcache-behavior-import.js'
  ].forEach(file => {
    const bundler = browserify(`${SRC_DIR}/${file}`);

    bundler.bundle()
      .on('error', error => {
        console.error(error);
        bundler.emit('end');
      })
      .pipe(source(file))
      .pipe(buffer())
      .pipe(gulp.dest(BUILD_DIR));
  });
});

gulp.task('default', callback => {
  const sequence = require('run-sequence');

  sequence('lint', 'clean', 'build', callback);
});
