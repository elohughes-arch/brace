/* A function with no dynamic segment in its path, so that "is /api/run/<stage>
   reachable?" and "does this project build serverless functions at all?" can be
   told apart. Answers GET on purpose. Deliberately says nothing about
   configuration — an anonymous caller learns only that the runtime is alive. */

module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ok: true, runtime: process.version });
};
