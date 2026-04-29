export default function BlogPost({ params }: { params: { slug: string } }) {
  return <div>Blog: {params.slug}</div>;
}
